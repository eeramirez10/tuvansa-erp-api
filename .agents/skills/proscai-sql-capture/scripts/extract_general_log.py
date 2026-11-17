"""Offline general_log FILE extraction. No database connection or log control."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

STAMP = r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})"
ENTRY = re.compile(rf"^(?P<timestamp>{STAMP})\s+(?P<thread>\d+)\s+(?P<rest>.*)$")
COMMANDS = sorted(["Query", "Execute", "Prepare", "Connect", "Quit", "Init DB", "Field List", "Close stmt", "Reset stmt", "Long Data", "Set option", "Binlog Dump", "Statistics", "Ping", "Sleep", "Shutdown", "Refresh", "Processlist", "Kill", "Change user", "Reset Connection", "Daemon"], key=len, reverse=True)
COMMAND = re.compile(r"^(" + "|".join(re.escape(c) for c in COMMANDS) + r")(?:[ \t](.*)|$)")
OLD_ENTRY = re.compile(r"^\s*(?:\d{6}\s+\d{1,2}:\d{2}:\d{2}\s+)?\d+\s+(?:Query|Execute|Prepare|Connect|Quit)\b")


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("Dates require an explicit timezone, such as Z or -06:00")
    return parsed.astimezone(timezone.utc)


def without_ending(value: str) -> str:
    return value[:-2] if value.endswith("\r\n") else value[:-1] if value.endswith("\n") else value


def startup(line: str) -> bool:
    text = line.strip()
    version = re.fullmatch(r"[^\"']*(?:mysqld|mariadbd)[^,\r\n]*,\s+Version: .*started with:", text, re.IGNORECASE)
    return bool(text.startswith("Tcp port:") or version or re.fullmatch(r"Time\s+Id\s+Command\s+Argument", text))


def events(stream):
    current = None
    for line_number, line in enumerate(stream, 1):
        clean = without_ending(line)
        match = ENTRY.match(clean)
        if match:
            if current:
                current["argument"] = without_ending(current["argument"])
                yield current
            command = COMMAND.fullmatch(match["rest"])
            if not command:
                raise ValueError(f"Unsupported general_log command at line {line_number}")
            instant(match["timestamp"])
            ending = line[len(clean):]
            current = {"timestamp": match["timestamp"], "thread_id": int(match["thread"]), "command": command[1],
                       "argument": (command[2] or "") + ending, "raw": line}
        elif re.match(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:", clean) or OLD_ENTRY.match(clean):
            raise ValueError(f"Unsupported or timezone-less log entry at line {line_number}; no partial extraction written")
        elif startup(clean) and (current is None or current["command"] in ("Quit", "Shutdown") or "Version:" in clean):
            if current:
                current["argument"] = without_ending(current["argument"])
                yield current
                current = None
        elif current:
            current["argument"] += line
            current["raw"] += line
        elif clean.strip():
            raise ValueError(f"Unrecognized preamble at line {line_number}; use a complete general_log FILE copy")
    if current:
        current["argument"] = without_ending(current["argument"])
        yield current


def extract(input_path: Path, output_dir: Path, thread_id: int, start: str, end: str, encoding: str = "utf-8") -> dict:
    first, last = instant(start), instant(end)
    if first > last or thread_id < 1:
        raise ValueError("Start must not follow end and thread-id must be positive")
    if output_dir.exists():
        raise FileExistsError("Output directory already exists; choose a new capture directory")
    before = input_path.stat()
    digest = hashlib.sha256()
    with input_path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    selected, total = [], 0
    with input_path.open("r", encoding=encoding, errors="strict", newline="") as source:
        for event in events(source):
            total += 1
            if event["thread_id"] == thread_id and first <= instant(event["timestamp"]) <= last:
                selected.append(event)
    after = input_path.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("Input changed while reading; copy the log first")
    queries = [e for e in selected if e["command"] in ("Query", "Execute")]
    metadata = {"input_file": input_path.name, "sha256": digest.hexdigest(), "encoding": encoding,
                "thread_id": thread_id, "start": start, "end": end, "interval": "inclusive",
                "parsed_events": total, "selected_events": len(selected), "query_execute_count": len(queries),
                "order": "physical file order; repetitions preserved", "omnis_thread_must_be_verified_separately": True}
    output_dir.mkdir(parents=True, exist_ok=False)
    with (output_dir / "events.jsonl").open("x", encoding="utf-8", newline="") as target:
        for event in selected:
            target.write(json.dumps(event, ensure_ascii=False) + "\n")
    with (output_dir / "queries.sql").open("x", encoding="utf-8", newline="") as target:
        for event in queries:
            target.write(f"-- {event['timestamp']} thread {event['thread_id']} {event['command']}\n")
            target.write(event["argument"])
            target.write("\n\n")
    (output_dir / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    return metadata


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="Stable general_log FILE copy with ISO 8601 timestamps and timezone")
    parser.add_argument("--thread-id", required=True, type=int, help="Verified MySQL OMNIS thread ID, not proxy connectionId")
    parser.add_argument("--start", required=True, help="Inclusive ISO 8601 time with timezone")
    parser.add_argument("--end", required=True, help="Inclusive ISO 8601 time with timezone")
    parser.add_argument("--output-dir", required=True, type=Path, help="New directory, normally under captures/")
    parser.add_argument("--encoding", default="utf-8", help="Verified source encoding; defaults to strict UTF-8")
    args = parser.parse_args()
    try:
        metadata = extract(args.input, args.output_dir, args.thread_id, args.start, args.end, args.encoding)
    except (OSError, ValueError, LookupError) as error:
        parser.exit(2, f"Extraction failed: {error}\n")
    print(json.dumps({"output_dir": str(args.output_dir), "selected_events": metadata["selected_events"], "query_execute_count": metadata["query_execute_count"]}))


if __name__ == "__main__":
    main()
