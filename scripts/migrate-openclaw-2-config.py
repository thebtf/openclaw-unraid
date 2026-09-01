#!/usr/bin/env python3
"""Safely apply the narrow OpenClaw v2026.8.1 config migrations.

The default is a dry run. Use --apply only after reviewing the path-only plan.
No config values are emitted by this tool.
"""

import argparse
import codecs
import errno
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
from typing import Any, Dict, List, Optional, Sequence, Tuple


MISSING = object()
# A migration may carry forward only a literal provider/model reference,
# including slash-separated provider namespaces and model IDs. Patterns,
# aliases, and profile selectors are not safe to reinterpret in a recovery
# script.
MODEL_REFERENCE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._:+-]*)+$"
)
# Legacy agents.list IDs must already be canonical keyed-entry names.
AGENT_ID = re.compile(r"^[a-z0-9_][a-z0-9_-]{0,63}$")


class MigrationError(Exception):
    """An input or safety condition that must leave the original untouched."""


class ChangeLog:
    """Keep a deterministic, value-free list of modified configuration paths."""

    def __init__(self) -> None:
        self._paths: List[str] = []
        self._seen = set()

    def add(self, path: str) -> None:
        if path not in self._seen:
            self._seen.add(path)
            self._paths.append(path)

    @property
    def paths(self) -> List[str]:
        return self._paths


class LegacyAllowedModels:
    """Distinguish an empty legacy list from unusable legacy values."""

    def __init__(self, models: List[str], materialize: bool) -> None:
        self.models = models
        self.materialize = materialize


def _shape_error(path: str) -> MigrationError:
    return MigrationError("invalid configuration shape at " + path)


def _expect_object(value: Any, path: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise _shape_error(path)
    return value


def _expect_list(value: Any, path: str) -> List[Any]:
    if not isinstance(value, list):
        raise _shape_error(path)
    return value

def _validate_memory_search(value: Any, path: str) -> Dict[str, Any]:
    search = _expect_object(value, path)
    for key in ("query", "store"):
        if key in search:
            _expect_object(search[key], path + "." + key)
    return search


def _roster_error(path: str) -> MigrationError:
    return MigrationError(
        "unsafe agent roster at " + path + "; run openclaw doctor --fix"
    )


def _validate_legacy_agent_roster(entries: List[Any]) -> None:
    if not entries:
        raise _roster_error("agents.list")

    ids = set()
    for index, entry in enumerate(entries):
        entry_path = "agents.list[{}]".format(index)
        if not isinstance(entry, dict):
            raise _roster_error(entry_path)
        agent_id = entry.get("id")
        if (
            not isinstance(agent_id, str)
            or not agent_id
            or agent_id != agent_id.strip()
            or not AGENT_ID.fullmatch(agent_id)
        ):
            raise _roster_error(entry_path + ".id")
        if agent_id in ids:
            raise _roster_error(entry_path + ".id")
        ids.add(agent_id)
        if "default" in entry:
            default = entry["default"]
            if not isinstance(default, bool) or default:
                raise _roster_error(entry_path + ".default")


def _validate_keyed_agent_roster(entries: Dict[str, Any], ownership: Any) -> None:
    if not entries:
        raise _roster_error("agents.entries")

    marked = 0
    for entry in entries.values():
        if not isinstance(entry, dict):
            raise _roster_error("agents.entries")
        if "default" in entry:
            default = entry["default"]
            if not isinstance(default, bool):
                raise _roster_error("agents.entries")
            if default:
                marked += 1

    if marked > 1:
        raise _roster_error("agents.entries")
    if ownership == "explicit" and marked:
        raise _roster_error("agents.ownership")


def _validate_agent_roster(agents: Dict[str, Any]) -> None:
    has_list = "list" in agents
    has_entries = "entries" in agents
    if has_list and has_entries:
        raise _roster_error("agents")

    ownership = agents.get("ownership", MISSING)
    if ownership is not MISSING and ownership != "explicit":
        raise _roster_error("agents.ownership")

    if has_list:
        entries = agents["list"]
        if not isinstance(entries, list):
            raise _roster_error("agents.list")
        _validate_legacy_agent_roster(entries)
    elif has_entries:
        entries = agents["entries"]
        if not isinstance(entries, dict):
            raise _roster_error("agents.entries")
        _validate_keyed_agent_roster(entries, ownership)


def _normalize_allowed_models(value: Any) -> LegacyAllowedModels:
    normalized: List[str] = []
    if isinstance(value, list):
        if not value:
            return LegacyAllowedModels(normalized, False)
        for item in value:
            if (
                isinstance(item, str)
                and item == item.strip()
                and MODEL_REFERENCE.fullmatch(item)
            ):
                normalized.append(item)
    return LegacyAllowedModels(normalized, True)



def _validate_configuration(root: Any) -> Optional[LegacyAllowedModels]:
    """Validate just the named migration surface before any in-memory mutation."""
    root = _expect_object(root, "$")

    if "meta" in root:
        _expect_object(root["meta"], "meta")
    if "memorySearch" in root:
        _validate_memory_search(root["memorySearch"], "memorySearch")
    if "memory" in root:
        memory = _expect_object(root["memory"], "memory")
        if "search" in memory:
            _validate_memory_search(memory["search"], "memory.search")

    if "agents" in root:
        agents = _expect_object(root["agents"], "agents")
        if "defaults" in agents:
            defaults = _expect_object(agents["defaults"], "agents.defaults")
            if "memorySearch" in defaults:
                _validate_memory_search(defaults["memorySearch"], "agents.defaults.memorySearch")
            if "mediaModels" in defaults:
                _expect_object(defaults["mediaModels"], "agents.defaults.mediaModels")
            if "compaction" in defaults:
                _expect_object(defaults["compaction"], "agents.defaults.compaction")
        _validate_agent_roster(agents)

        if "list" in agents:
            entries = _expect_list(agents["list"], "agents.list")
            for index, entry in enumerate(entries):
                entry_path = "agents.list[{}]".format(index)
                entry_object = _expect_object(entry, entry_path)
                if "memorySearch" in entry_object:
                    _validate_memory_search(entry_object["memorySearch"], entry_path + ".memorySearch")
                if "memory" in entry_object:
                    memory = _expect_object(entry_object["memory"], entry_path + ".memory")
                    if "search" in memory:
                        _validate_memory_search(memory["search"], entry_path + ".memory.search")
        if "entries" in agents:
            named_entries = _expect_object(agents["entries"], "agents.entries")
            for entry in named_entries.values():
                entry_path = "agents.entries.*"
                entry_object = _expect_object(entry, entry_path)
                if "memorySearch" in entry_object:
                    _validate_memory_search(entry_object["memorySearch"], entry_path + ".memorySearch")
                if "memory" in entry_object:
                    memory = _expect_object(entry_object["memory"], entry_path + ".memory")
                    if "search" in memory:
                        _validate_memory_search(memory["search"], entry_path + ".memory.search")

    if "gateway" in root:
        gateway = _expect_object(root["gateway"], "gateway")
        if "controlUi" in gateway:
            _expect_object(gateway["controlUi"], "gateway.controlUi")

    normalized_models: Optional[LegacyAllowedModels] = None
    if "plugins" in root:
        plugins = _expect_object(root["plugins"], "plugins")
        if "entries" in plugins:
            plugin_entries = _expect_object(plugins["entries"], "plugins.entries")
            if "llm-task" in plugin_entries:
                llm_task = _expect_object(plugin_entries["llm-task"], "plugins.entries.llm-task")
                if "config" in llm_task:
                    config = _expect_object(llm_task["config"], "plugins.entries.llm-task.config")
                    if "allowedModels" in config:
                        normalized_models = _normalize_allowed_models(config["allowedModels"])
                if "llm" in llm_task:
                    llm = _expect_object(llm_task["llm"], "plugins.entries.llm-task.llm")
                    for key in ("allowModelOverride", "allowAuthProfileOverride"):
                        if key in llm and not isinstance(llm[key], bool):
                            raise _shape_error("plugins.entries.llm-task.llm." + key)

                    if "allowedCompletionModels" in llm:
                        _expect_list(
                            llm["allowedCompletionModels"],
                            "plugins.entries.llm-task.llm.allowedCompletionModels",
                        )

    return normalized_models


def _migrate_memory_search(root: Dict[str, Any], changes: ChangeLog) -> None:
    """Merge the two legacy global sources; canonical keys always take precedence."""
    legacy_sources: List[Dict[str, Any]] = []

    if "memorySearch" in root:
        legacy_sources.append(root.pop("memorySearch"))
        changes.add("memorySearch")

    agents = root.get("agents")
    if isinstance(agents, dict):
        defaults = agents.get("defaults")
        if isinstance(defaults, dict) and "memorySearch" in defaults:
            legacy_sources.append(defaults.pop("memorySearch"))
            changes.add("agents.defaults.memorySearch")

    if not legacy_sources:
        return

    if "memory" not in root:
        root["memory"] = {}
    memory = root["memory"]
    canonical = memory.get("search", MISSING)
    canonical_values: Dict[str, Any] = {} if canonical is MISSING else canonical

    # Legacy sources are applied in the named order. Existing canonical keys
    # are applied last, so even falsey explicit canonical values win.
    merged: Dict[str, Any] = {}
    for source in legacy_sources:
        merged.update(source)
    merged.update(canonical_values)

    if canonical is MISSING or merged != canonical_values:
        memory["search"] = merged
        changes.add("memory.search")


def _migrate_memory_search_settings(
    search: Dict[str, Any], path: str, changes: ChangeLog
) -> None:
    # v2026.8.1 accepts no replacement for these retired tuning fields; omit
    # them so the runtime's built-in chunking defaults apply.
    for legacy_key in ("chunkSize", "chunkOverlap"):
        if legacy_key in search:
            del search[legacy_key]
            changes.add(path + "." + legacy_key)
    if "chunking" in search:
        del search["chunking"]
        changes.add(path + ".chunking")

    if "maxResults" in search:
        legacy_value = search.pop("maxResults")
        changes.add(path + ".maxResults")
        if "query" not in search:
            search["query"] = {}
        if "maxResults" not in search["query"]:
            search["query"]["maxResults"] = legacy_value
            changes.add(path + ".query.maxResults")

    if search.get("provider") == "auto":
        search["provider"] = "openai"
        changes.add(path + ".provider")

    if "store" in search and "path" in search["store"]:
        del search["store"]["path"]
        changes.add(path + ".store.path")


def _migrate_canonical_agent_memory_search(
    entry: Dict[str, Any], path: str, changes: ChangeLog
) -> None:
    memory = entry.get("memory")
    if isinstance(memory, dict) and "search" in memory:
        _migrate_memory_search_settings(memory["search"], path + ".memory.search", changes)

def _migrate_agent_memory_search(
    entry: Dict[str, Any], path: str, changes: ChangeLog
) -> None:
    if "memorySearch" in entry:
        legacy = entry["memorySearch"]
        if "memory" not in entry:
            entry["memory"] = {}
        memory = entry["memory"]
        canonical = memory.get("search", MISSING)
        canonical_values: Dict[str, Any] = {} if canonical is MISSING else canonical

        merged = dict(legacy)
        merged.update(canonical_values)
        if canonical is MISSING or merged != canonical_values:
            memory["search"] = merged
            changes.add(path + ".memory.search")

        del entry["memorySearch"]
        changes.add(path + ".memorySearch")
    _migrate_canonical_agent_memory_search(entry, path, changes)



def _migrate_agent_roster(root: Dict[str, Any], changes: ChangeLog) -> None:
    agents = root.get("agents")
    if not isinstance(agents, dict):
        return

    if "list" in agents:
        converted_entries: Dict[str, Any] = {}
        for index, entry in enumerate(agents["list"]):
            agent_id = entry.pop("id")
            converted_entries[agent_id] = entry
            changes.add("agents.list[{}].id".format(index))
        del agents["list"]
        agents["entries"] = converted_entries
        changes.add("agents.list")
        changes.add("agents.entries")
        if len(converted_entries) > 1 and "ownership" not in agents:
            agents["ownership"] = "explicit"
            changes.add("agents.ownership")
        return

    keyed_entries = agents.get("entries")
    if not isinstance(keyed_entries, dict) or len(keyed_entries) <= 1 or "ownership" in agents:
        return
    if any(entry.get("default") is True for entry in keyed_entries.values()):
        return
    agents["ownership"] = "explicit"
    changes.add("agents.ownership")


def _migrate_agent_memory_searches(root: Dict[str, Any], changes: ChangeLog) -> None:
    agents = root.get("agents")
    if not isinstance(agents, dict):
        return

    legacy_entries = agents.get("list")
    if isinstance(legacy_entries, list):
        for index, entry in enumerate(legacy_entries):
            _migrate_agent_memory_search(entry, "agents.list[{}]".format(index), changes)

    named_entries = agents.get("entries")
    if isinstance(named_entries, dict):
        for entry in named_entries.values():
            _migrate_agent_memory_search(entry, "agents.entries.*", changes)


def _migrate_agent_defaults(root: Dict[str, Any], changes: ChangeLog) -> None:
    agents = root.get("agents")
    if not isinstance(agents, dict) or "defaults" not in agents:
        return
    defaults = agents["defaults"]

    if "imageGenerationModel" in defaults:
        legacy_image = defaults.pop("imageGenerationModel")
        changes.add("agents.defaults.imageGenerationModel")
        if "mediaModels" not in defaults:
            defaults["mediaModels"] = {}
        media_models = defaults["mediaModels"]
        if "image" not in media_models:
            media_models["image"] = legacy_image
            changes.add("agents.defaults.mediaModels.image")

    if "mediaGenerationAutoProviderFallback" in defaults:
        del defaults["mediaGenerationAutoProviderFallback"]
        changes.add("agents.defaults.mediaGenerationAutoProviderFallback")

    if "compaction" not in defaults:
        return
    compaction = defaults["compaction"]
    if "truncateAfterCompaction" not in compaction:
        return

    was_false = compaction["truncateAfterCompaction"] is False
    del compaction["truncateAfterCompaction"]
    changes.add("agents.defaults.compaction.truncateAfterCompaction")
    if was_false and "maxActiveTranscriptBytes" in compaction:
        del compaction["maxActiveTranscriptBytes"]
        changes.add("agents.defaults.compaction.maxActiveTranscriptBytes")


def _migrate_gateway_controls(root: Dict[str, Any], changes: ChangeLog) -> None:
    gateway = root.get("gateway")
    if not isinstance(gateway, dict) or "controlUi" not in gateway:
        return
    control_ui = gateway["controlUi"]

    for key in ("allowInsecureAuth", "dangerouslyDisableDeviceAuth"):
        if key in control_ui:
            del control_ui[key]
            changes.add("gateway.controlUi." + key)


def _migrate_llm_task(
    root: Dict[str, Any], normalized_models: Optional[LegacyAllowedModels], changes: ChangeLog
) -> None:
    plugins = root.get("plugins")
    if not isinstance(plugins, dict) or "entries" not in plugins:
        return
    entries = plugins["entries"]
    if "llm-task" not in entries:
        return

    llm_task = entries["llm-task"]
    if "llm" not in llm_task:
        llm_task["llm"] = {}
    llm = llm_task["llm"]
    for key in ("allowModelOverride", "allowAuthProfileOverride"):
        if key not in llm:
            llm[key] = True
            changes.add("plugins.entries.llm-task.llm." + key)

    if normalized_models is None:
        return

    config = llm_task["config"]
    if normalized_models.materialize and "allowedCompletionModels" not in llm:
        llm["allowedCompletionModels"] = normalized_models.models
        changes.add("plugins.entries.llm-task.llm.allowedCompletionModels")
    del config["allowedModels"]
    changes.add("plugins.entries.llm-task.config.allowedModels")


def _migrate(root: Dict[str, Any], normalized_models: Optional[LegacyAllowedModels]) -> List[str]:
    changes = ChangeLog()

    meta = root.get("meta")
    if isinstance(meta, dict) and "lastTouchedAt" in meta:
        del meta["lastTouchedAt"]
        changes.add("meta.lastTouchedAt")

    _migrate_memory_search(root, changes)
    memory = root.get("memory")
    if isinstance(memory, dict) and "search" in memory:
        _migrate_memory_search_settings(memory["search"], "memory.search", changes)
    _migrate_agent_memory_searches(root, changes)
    _migrate_agent_roster(root, changes)
    _migrate_agent_defaults(root, changes)
    _migrate_gateway_controls(root, changes)
    _migrate_llm_task(root, normalized_models, changes)
    return changes.paths


def _assert_memory_search_invariants(search: Dict[str, Any], path: str) -> None:
    for legacy_key in ("chunkSize", "chunkOverlap", "maxResults", "chunking"):
        if legacy_key in search:
            raise MigrationError(
                "migration invariant failed: legacy path remains: " + path + "." + legacy_key
            )
    if search.get("provider") == "auto":
        raise MigrationError("migration invariant failed: legacy path remains: " + path + ".provider")
    store = search.get("store")
    if isinstance(store, dict) and "path" in store:
        raise MigrationError("migration invariant failed: legacy path remains: " + path + ".store.path")


def _assert_canonical_agent_memory_search(entry: Dict[str, Any], path: str) -> None:
    memory = entry.get("memory")
    if isinstance(memory, dict) and isinstance(memory.get("search"), dict):
        _assert_memory_search_invariants(memory["search"], path + ".memory.search")


def _assert_agent_roster_invariants(
    agents: Dict[str, Any], converted_legacy_list: bool
) -> None:
    if "list" in agents:
        raise MigrationError("migration invariant failed: legacy path remains: agents.list")

    entries = agents.get("entries")
    if not isinstance(entries, dict):
        return
    marked = sum(entry.get("default") is True for entry in entries.values())
    ownership = agents.get("ownership")
    if marked > 1:
        raise MigrationError("migration invariant failed: multiple default agent markers remain")
    if ownership == "explicit" and marked:
        raise MigrationError(
            "migration invariant failed: agents.ownership conflicts with default marker"
        )
    if len(entries) > 1 and not marked and ownership != "explicit":
        raise MigrationError(
            "migration invariant failed: markerless multi-agent roster lacks agents.ownership"
        )
    if converted_legacy_list and any("id" in entry for entry in entries.values()):
        raise MigrationError("migration invariant failed: legacy path remains: agents.entries.*.id")


def _assert_legacy_paths_absent(
    root: Dict[str, Any], converted_legacy_list: bool = False
) -> None:
    meta = root.get("meta")
    if isinstance(meta, dict) and "lastTouchedAt" in meta:
        raise MigrationError("migration invariant failed: legacy path remains: meta.lastTouchedAt")
    if "memorySearch" in root:
        raise MigrationError("migration invariant failed: legacy path remains: memorySearch")
    memory = root.get("memory")
    if isinstance(memory, dict) and isinstance(memory.get("search"), dict):
        _assert_memory_search_invariants(memory["search"], "memory.search")

    agents = root.get("agents")
    if isinstance(agents, dict):
        defaults = agents.get("defaults")
        if isinstance(defaults, dict):
            for key in (
                "memorySearch",
                "imageGenerationModel",
                "mediaGenerationAutoProviderFallback",
            ):
                if key in defaults:
                    raise MigrationError(
                        "migration invariant failed: legacy path remains: agents.defaults." + key
                    )
            compaction = defaults.get("compaction")
            if isinstance(compaction, dict) and "truncateAfterCompaction" in compaction:
                raise MigrationError(
                    "migration invariant failed: legacy path remains: "
                    "agents.defaults.compaction.truncateAfterCompaction"
                )
        _assert_agent_roster_invariants(agents, converted_legacy_list)
        named_entries = agents.get("entries")
        if isinstance(named_entries, dict):
            for entry in named_entries.values():
                if isinstance(entry, dict) and "memorySearch" in entry:
                    raise MigrationError(
                        "migration invariant failed: legacy path remains: "
                        "agents.entries.*.memorySearch"
                    )
                if isinstance(entry, dict):
                    _assert_canonical_agent_memory_search(entry, "agents.entries.*")


    gateway = root.get("gateway")
    if isinstance(gateway, dict):
        control_ui = gateway.get("controlUi")
        if isinstance(control_ui, dict):
            for key in ("allowInsecureAuth", "dangerouslyDisableDeviceAuth"):
                if key in control_ui:
                    raise MigrationError(
                        "migration invariant failed: legacy path remains: gateway.controlUi." + key
                    )

    plugins = root.get("plugins")
    if isinstance(plugins, dict):
        entries = plugins.get("entries")
        if isinstance(entries, dict):
            llm_task = entries.get("llm-task")
            if isinstance(llm_task, dict):
                llm = llm_task.get("llm")
                if not isinstance(llm, dict):
                    raise MigrationError(
                        "migration invariant failed: missing plugins.entries.llm-task.llm"
                    )
                for key in ("allowModelOverride", "allowAuthProfileOverride"):
                    if key not in llm:
                        raise MigrationError(
                            "migration invariant failed: missing plugins.entries.llm-task.llm."
                            + key
                        )
                    if not isinstance(llm[key], bool):
                        raise MigrationError(
                            "migration invariant failed: non-boolean plugins.entries.llm-task.llm."
                            + key
                        )
                config = llm_task.get("config")
                if isinstance(config, dict) and "allowedModels" in config:
                    raise MigrationError(
                        "migration invariant failed: legacy path remains: "
                        "plugins.entries.llm-task.config.allowedModels"
                    )


def _reject_duplicate_keys(pairs: Sequence[Tuple[str, Any]]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise MigrationError("configuration contains a duplicate JSON object key")
        result[key] = value
    return result


def _reject_nonstandard_constant(_: str) -> None:
    raise ValueError("non-standard JSON constant")


def _load_json(data: bytes) -> Tuple[Dict[str, Any], bool]:
    has_bom = data.startswith(codecs.BOM_UTF8)
    json_bytes = data[len(codecs.BOM_UTF8) :] if has_bom else data
    try:
        text = json_bytes.decode("utf-8")
        root = json.loads(
            text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonstandard_constant,
        )
    except MigrationError:
        raise
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise MigrationError("configuration is not valid strict JSON") from error

    return _expect_object(root, "$"), has_bom


def _serialize_json(root: Dict[str, Any], has_bom: bool) -> bytes:
    try:
        text = json.dumps(root, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        encoded = text.encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise MigrationError("configuration cannot be serialized safely") from error
    return (codecs.BOM_UTF8 if has_bom else b"") + encoded


def _fingerprint(file_stat: os.stat_result) -> Tuple[int, int, int, int, int, int]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
        stat.S_IMODE(file_stat.st_mode),
    )


def _read_regular_file(path: Path) -> Tuple[bytes, Tuple[int, int, int, int, int, int], int]:
    try:
        initial = path.lstat()
        if not stat.S_ISREG(initial.st_mode):
            raise MigrationError("configuration must be a regular file")
        with path.open("rb") as source:
            data = source.read()
        final = path.lstat()
    except MigrationError:
        raise
    except OSError as error:
        raise MigrationError("configuration cannot be read") from error

    initial_fingerprint = _fingerprint(initial)
    final_fingerprint = _fingerprint(final)
    if initial_fingerprint != final_fingerprint:
        raise MigrationError("configuration changed while being read")
    return data, final_fingerprint, stat.S_IMODE(final.st_mode)


def _assert_source_unchanged(
    path: Path, original: bytes, original_fingerprint: Tuple[int, int, int, int, int, int]
) -> None:
    current, current_fingerprint, _ = _read_regular_file(path)
    if current != original or current_fingerprint != original_fingerprint:
        raise MigrationError("configuration changed while migration was staged")


def _write_all(file_descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(file_descriptor, view)
        if written <= 0:
            raise OSError("short write")
        view = view[written:]


def _timestamped_backup_path(config_path: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    base = "{}.v2026.8.1-backup-{}".format(config_path.name, stamp)
    for attempt in range(10000):
        suffix = "" if attempt == 0 else "-{}".format(attempt)
        candidate = config_path.with_name(base + suffix)
        if not candidate.exists():
            return candidate
    raise MigrationError("could not reserve a unique adjacent backup path")


def _create_backup(config_path: Path, source: bytes, mode: int) -> Path:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
    for _ in range(10000):
        backup_path = _timestamped_backup_path(config_path)
        try:
            descriptor = os.open(str(backup_path), flags, mode)
        except FileExistsError:
            continue
        try:
            os.fchmod(descriptor, mode)
            _write_all(descriptor, source)
            os.fsync(descriptor)
        except Exception:
            os.close(descriptor)
            try:
                backup_path.unlink()
            except OSError:
                pass
            raise
        else:
            os.close(descriptor)

        try:
            if backup_path.read_bytes() != source:
                backup_path.unlink()
                raise MigrationError("backup verification failed")
        except MigrationError:
            raise
        except OSError as error:
            try:
                backup_path.unlink()
            except OSError:
                pass
            raise MigrationError("backup verification failed") from error
        return backup_path

    raise MigrationError("could not create a unique adjacent backup")


def _stage_replacement(config_path: Path, replacement: bytes, mode: int) -> Path:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".{}-".format(config_path.name), suffix=".tmp", dir=str(config_path.parent)
    )
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        _write_all(descriptor, replacement)
        os.fsync(descriptor)
    except Exception:
        os.close(descriptor)
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise
    else:
        os.close(descriptor)
    return temporary_path


def _fsync_parent_directory(directory: Path) -> None:
    """Persist the replacement's directory entry where the platform supports it."""
    directory_flag = getattr(os, "O_DIRECTORY", None)
    if directory_flag is None:
        return
    try:
        descriptor = os.open(str(directory), os.O_RDONLY | directory_flag)
    except OSError as error:
        if error.errno in (errno.EINVAL, errno.ENOTSUP, errno.ENOSYS):
            return
        raise
    try:
        try:
            os.fsync(descriptor)
        except OSError as error:
            if error.errno not in (errno.EINVAL, errno.ENOTSUP, errno.ENOSYS):
                raise
    finally:
        os.close(descriptor)


def _print_paths(heading: str, paths: Sequence[str]) -> None:
    print(heading)
    for path in paths:
        print("  - " + path)


def migrate(config_path: Path, apply: bool) -> int:
    original, source_fingerprint, mode = _read_regular_file(config_path)
    root, has_bom = _load_json(original)
    normalized_models = _validate_configuration(root)

    changes = _migrate(root, normalized_models)
    converted_legacy_list = "agents.list" in changes
    _validate_configuration(root)
    _assert_legacy_paths_absent(root, converted_legacy_list)

    if not changes:
        print("already migrated")
        return 0

    replacement = _serialize_json(root, has_bom)
    reparsed, _ = _load_json(replacement)
    _validate_configuration(reparsed)
    _assert_legacy_paths_absent(reparsed, converted_legacy_list)
    if reparsed != root:
        raise MigrationError("serialized migration did not preserve configuration semantics")

    if not apply:
        _print_paths("dry run: planned changed paths", changes)
        return 0

    _assert_source_unchanged(config_path, original, source_fingerprint)
    backup_path = _create_backup(config_path, original, mode)
    _fsync_parent_directory(config_path.parent)
    temporary_path: Optional[Path] = None
    replaced = False
    try:
        temporary_path = _stage_replacement(config_path, replacement, mode)
        _assert_source_unchanged(config_path, original, source_fingerprint)
        os.replace(str(temporary_path), str(config_path))
        temporary_path = None
        replaced = True
        _fsync_parent_directory(config_path.parent)
    except OSError:
        if replaced:
            print("ERROR: replacement completed but parent directory sync failed", file=sys.stderr)
            print("backup: " + str(backup_path), file=sys.stderr)
            return 1
        raise
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except OSError:
                pass

    print("applied migration")
    print("backup: " + str(backup_path))
    _print_paths("changed paths", changes)
    return 0


def _parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Apply only the OpenClaw v2026.8.1 recovery migrations to a JSON config."
    )
    parser.add_argument("--config", required=True, type=Path, metavar="PATH", help="OpenClaw JSON config")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--apply",
        action="store_true",
        help="create a backup and atomically replace the config (default: dry run)",
    )
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="report planned path changes without writing files (default)",
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _parse_args(argv)
    try:
        return migrate(args.config.expanduser(), args.apply)
    except MigrationError as error:
        print("ERROR: " + str(error), file=sys.stderr)
        return 1
    except OSError:
        print("ERROR: filesystem operation failed", file=sys.stderr)
        return 1
    except Exception:
        print("ERROR: migration failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
