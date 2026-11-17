"""Synthetic fixtures only. Never connects to MySQL or touches its configuration."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / ".agents/skills/proscai-sql-capture/scripts/extract_general_log.py"
spec = importlib.util.spec_from_file_location("extract_general_log", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

LOG = ("Time                 Id Command    Argument\r\n"
       "2026-11-17T16:00:00.000001Z 123 Query SELECT 'before'\r\n"
       "2026-11-17T16:00:01.000001Z 900 Query SELECT 'START_TEST'\r\n"
       "2026-11-17T16:00:01.000001Z 123 Query SELECT 'example'\r\n  FROM test_table\r\n WHERE code = 'A'\r\n"
       "2026-11-17T16:00:01.000001Z 123 Query SELECT 'example'\r\n  FROM test_table\r\n WHERE code = 'A'\r\n"
       "2026-11-17T16:00:02.000001Z 123 Prepare SELECT ?\r\n"
       "2026-11-17T16:00:02.000002Z 123 Execute SELECT 'B'\r\n"
       "2026-11-17T16:00:03.000001Z 123 Query COMMIT\r\n"
       "2026-11-17T16:00:03.000001Z 124 Query SELECT 'reconnected'\r\n"
       "2026-11-17T16:00:04.000001Z 123 Quit\r\n")


class GeneralLogExtraction(unittest.TestCase):
    def test_exact_multiline_order_repetitions_thread_and_timezone(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "raw.log", root / "extract"
            source.write_bytes(LOG.encode("utf-8"))
            metadata = module.extract(source, output, 123, "2026-11-17T10:00:01.000001-06:00", "2026-11-17T10:00:03.000001-06:00")
            rows = [json.loads(line) for line in (output / "events.jsonl").read_text(encoding="utf-8").splitlines()]
            self.assertEqual([r["command"] for r in rows], ["Query", "Query", "Prepare", "Execute", "Query"])
            self.assertEqual(rows[0]["argument"], "SELECT 'example'\r\n  FROM test_table\r\n WHERE code = 'A'")
            self.assertEqual(rows[0]["argument"], rows[1]["argument"])
            self.assertTrue(rows[0]["raw"].endswith("\r\n"))
            self.assertEqual(metadata["selected_events"], 5)
            self.assertEqual(metadata["query_execute_count"], 4)
            sql = (output / "queries.sql").read_text(encoding="utf-8")
            self.assertNotIn("SELECT ?", sql)
            self.assertNotIn("START_TEST", sql)
            self.assertNotIn("reconnected", sql)
            self.assertIn("COMMIT", sql)
            self.assertNotIn(";", sql)
            self.assertEqual(source.read_bytes(), LOG.encode("utf-8"))

    def test_unknown_or_old_formats_fail_without_partial_output(self):
        for text in ["261117 16:00:01 123 Query SELECT 1\n", "2026-11-17T16:00:01 123 Query SELECT 1\n", "{\"type\":\"query\"}\n", LOG + "2026-11-17T16:00:06Z 123 Unknown SELECT 1\n"]:
            with self.subTest(text=text[:20]), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, output = root / "raw.log", root / "out"
                source.write_bytes(text.encode("utf-8"))
                with self.assertRaises(ValueError):
                    module.extract(source, output, 123, "2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z")
                self.assertFalse(output.exists())

    def test_timezone_interval_and_thread_are_required(self):
        for start, end, thread in [("2026-11-17T00:00:00", "2026-11-18T00:00:00Z", 123), ("2026-11-18T00:00:00Z", "2026-11-17T00:00:00Z", 123), ("2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z", 0)]:
            with self.subTest(start=start, thread=thread), tempfile.TemporaryDirectory() as temporary:
                with self.assertRaises(ValueError):
                    module.extract(Path(temporary) / "missing", Path(temporary) / "out", thread, start, end)

    def test_zero_results_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "raw.log", root / "out"
            source.write_bytes(LOG.encode("utf-8"))
            metadata = module.extract(source, output, 999, "2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z")
            self.assertEqual(metadata["selected_events"], 0)
            self.assertEqual((output / "queries.sql").read_bytes(), b"")
            before = (output / "metadata.json").read_bytes()
            with self.assertRaises(FileExistsError):
                module.extract(source, output, 123, "2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z")
            self.assertEqual((output / "metadata.json").read_bytes(), before)

    def test_leading_sql_whitespace_is_literal(self):
        row = next(module.events(io.StringIO("2026-11-17T16:00:00Z 123 Query\t  SELECT 1\n")))
        self.assertEqual(row["argument"], "  SELECT 1")

    def test_sql_continuations_are_not_mistaken_for_startup_headers(self):
        text = "2026-11-17T16:00:00Z 123 Query SELECT 'one\nVersion: example started with:\nTime Id Command Argument\nTcp port: example\nend'\n"
        rows = list(module.events(io.StringIO(text)))
        self.assertEqual(len(rows), 1)
        self.assertIn("Tcp port: example", rows[0]["argument"])
        self.assertIn("Version: example", rows[0]["argument"])
        self.assertTrue(module.startup("C:/MySQL/mysqld.exe, Version: 8.0.0 (example). started with:"))

    def test_invalid_encoding_is_not_silently_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, output = root / "raw.log", root / "out"
            source.write_bytes(b"2026-11-17T16:00:00Z 123 Query SELECT '\xff'\n")
            with self.assertRaises(UnicodeDecodeError):
                module.extract(source, output, 123, "2026-11-17T00:00:00Z", "2026-11-18T00:00:00Z")
            self.assertFalse(output.exists())

    def test_transient_empty_argument_and_connection_commands(self):
        rows = list(module.events(io.StringIO("2026-11-17T16:00:00Z 123 Connect user@host on test\n2026-11-17T16:00:01Z 123 Init DB test\n2026-11-17T16:00:02Z 123 Quit\n")))
        self.assertEqual([r["command"] for r in rows], ["Connect", "Init DB", "Quit"])
        self.assertEqual(rows[-1]["argument"], "")


if __name__ == "__main__":
    unittest.main()
