#!/usr/bin/env python3
"""Turn exportgames output into the files published on Hugging Face.

This is the second half of the daily export PRIVACY.md promises. The first half
is `backend/cmd/exportgames`, which reads the database and resolves every name
and account id to what the policy allows. By the time records reach this script
they carry no account ids and no usernames that were not agreed to, so nothing
here has to know the privacy rules -- which is the point of putting the boundary
here rather than anywhere else.

What this half owns is state: which games have already been published, and
therefore which file a new game belongs in.

    exportgames -database db | export.py --state state.sqlite --out staging
    export.py --state state.sqlite --out staging --upload --repo user/dataset

Files are immutable. A day's file is written once and never rewritten, so a
game appears in exactly one file forever and the Hub never stores thirty
near-copies of a growing shard. That makes the ledger, not a timestamp
watermark, the thing that decides what is new: a game whose finished_at is
older than everything already published -- which happens whenever a drained
game is recorded long after it ended -- is still new if its id is not in the
ledger.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import sqlite3
import sys
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

# Row groups are small and a page index is written because the pgn column runs
# to 36 KB on a long bot game. Without both, the Hub's dataset viewer refuses
# the file with TooBigContentError, and a reader cannot project a few columns
# without dragging every move through memory.
ROW_GROUP_SIZE = 500
DATA_PAGE_SIZE = 256 * 1024

LEDGER_SCHEMA = """
CREATE TABLE IF NOT EXISTS published (
    game_id    TEXT PRIMARY KEY,
    shard      TEXT NOT NULL,
    published_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS published_shard_idx ON published(shard);
"""


def open_ledger(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    ledger = sqlite3.connect(path)
    ledger.executescript(LEDGER_SCHEMA)
    return ledger


def read_records(source: str) -> list[dict]:
    stream = sys.stdin if source == "-" else open(source, encoding="utf-8")
    try:
        return [json.loads(line) for line in stream if line.strip()]
    finally:
        if stream is not sys.stdin:
            stream.close()


def unpublished(ledger: sqlite3.Connection, records: list[dict]) -> list[dict]:
    """Drop records already in a published file.

    Done in Python against a set rather than as a SQL anti-join because the
    ledger is small enough to hold entirely -- a few hundred thousand ids after
    a year -- and because the order records arrive in is the order they should
    be written in.
    """
    seen = {row[0] for row in ledger.execute("SELECT game_id FROM published")}
    return [record for record in records if record["game_id"] not in seen]


def write_shard(records: list[dict], out: Path, date: str) -> list[tuple[Path, str]]:
    """Write the day's Parquet and PGN files. Returns (local path, repo path).

    The file is named for the day it is *published*, not the day its games
    were played. That is forced by immutability: a game discovered three days
    late would otherwise mean rewriting a file that is already out. The two
    agree for almost every row, and the dataset card says so.
    """
    year = date[:4]
    out.mkdir(parents=True, exist_ok=True)

    table = pa.Table.from_pylist(records)
    parquet_path = out / f"games-{date}.parquet"
    pq.write_table(
        table,
        parquet_path,
        compression="zstd",
        compression_level=9,
        row_group_size=ROW_GROUP_SIZE,
        write_page_index=True,
        data_page_size=DATA_PAGE_SIZE,
    )

    # Plain gzip from the standard library rather than zstd from a wheel: this
    # runs on an ARM board where every compiled dependency is a thing that can
    # fail to install, and the difference is about a quarter of a megabyte a
    # day. mtime=0 so identical input produces identical bytes, which is what
    # lets a re-run be compared against what was already uploaded.
    pgn_path = out / f"games-{date}.pgn.gz"
    with open(pgn_path, "wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=9, mtime=0) as archive:
            for record in records:
                archive.write(record["pgn"].encode("utf-8"))
                archive.write(b"\n")

    return [
        (parquet_path, f"data/{year}/{parquet_path.name}"),
        (pgn_path, f"pgn/{year}/{pgn_path.name}"),
    ]


def card_operation(api, repo: str, card: Path):
    """The dataset card, when the copy on the Hub is not the copy in the repo.

    The card is the one file here that is *meant* to be rewritten, which is why
    it is handled apart from the immutability guard below. It also carries the
    `configs`/`data_files` block, and without that block the Hub's viewer
    reports the dataset as empty no matter how much data is sitting in it:
    `data/2026/games-2026-09-11.parquet` matches none of the automatic split
    patterns, so the layout has to be declared rather than inferred.

    Returns None when the Hub already has this exact text, so an unchanged card
    does not add a commit a day to the history.
    """
    from huggingface_hub import CommitOperationAdd
    from huggingface_hub.errors import EntryNotFoundError

    wanted = card.read_text(encoding="utf-8")
    try:
        published = Path(
            api.hf_hub_download(repo_id=repo, repo_type="dataset", filename="README.md")
        ).read_text(encoding="utf-8")
        if published == wanted:
            return None
    except EntryNotFoundError:
        pass
    return CommitOperationAdd(
        path_in_repo="README.md", path_or_fileobj=wanted.encode("utf-8")
    )


def upload(files: list[tuple[Path, str]], repo: str, date: str, card: Path) -> None:
    """Push the day's files, refusing to overwrite anything already there.

    The existence check is the immutability guard, and it deliberately does not
    consult the ledger: if the ledger were ever lost or rebuilt wrong, this is
    what still stops a second run from rewriting a published file.
    """
    from huggingface_hub import CommitOperationAdd, HfApi

    api = HfApi()
    remote = [repo_path for _, repo_path in files]
    existing = {
        info.path
        for info in api.get_paths_info(repo, remote, repo_type="dataset")
    }
    if existing:
        raise SystemExit(
            f"refusing to overwrite files already published: {sorted(existing)}"
        )

    operations = [
        CommitOperationAdd(path_in_repo=repo_path, path_or_fileobj=str(local))
        for local, repo_path in files
    ]
    message = f"Add games published {date}"
    if card.is_file():
        if refresh := card_operation(api, repo, card):
            operations.append(refresh)
            message += ", refresh dataset card"

    api.create_commit(
        repo_id=repo,
        repo_type="dataset",
        operations=operations,
        commit_message=message,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jsonl", default="-", help="exportgames output, or - for stdin")
    parser.add_argument("--state", help="path to the ledger database")
    parser.add_argument("--out", help="directory to stage files in")
    parser.add_argument("--repo", default=os.environ.get("RPS_EXPORT_HF_REPO", ""))
    parser.add_argument(
        "--card",
        default=str(Path(__file__).with_name("dataset-card.md")),
        help="dataset card, published as README.md when it differs from the Hub's copy",
    )
    parser.add_argument(
        "--push-card",
        action="store_true",
        help="publish the card and exit, without looking at the archive",
    )
    parser.add_argument(
        "--date",
        default=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        help="publication date, naming the files (default today, UTC)",
    )
    parser.add_argument(
        "--upload",
        action="store_true",
        help="push to Hugging Face. Without it, files are written and nothing is sent.",
    )
    args = parser.parse_args()

    if args.push_card:
        if not args.repo:
            raise SystemExit("--push-card needs --repo or RPS_EXPORT_HF_REPO")
        from huggingface_hub import HfApi

        api = HfApi()
        refresh = card_operation(api, args.repo, Path(args.card))
        if refresh is None:
            print("the published card already matches this one")
            return 0
        api.create_commit(
            repo_id=args.repo,
            repo_type="dataset",
            operations=[refresh],
            commit_message="Update dataset card",
        )
        print(f"published the dataset card to {args.repo}")
        return 0

    if not args.state or not args.out:
        raise SystemExit("--state and --out are required unless --push-card is used")

    records = read_records(args.jsonl)
    ledger = open_ledger(Path(args.state))
    fresh = unpublished(ledger, records)
    if not fresh:
        print(f"nothing new to publish ({len(records)} record(s) already out)")
        return 0

    files = write_shard(fresh, Path(args.out), args.date)
    for local, repo_path in files:
        print(f"  {repo_path}  {local.stat().st_size:>9,} B")

    if not args.upload:
        print(
            f"staged {len(fresh)} game(s) for {args.date}; "
            "nothing uploaded and nothing recorded (no --upload)"
        )
        return 0
    if not args.repo:
        raise SystemExit("--upload needs --repo or RPS_EXPORT_HF_REPO")

    upload(files, args.repo, args.date, Path(args.card))
    # The ledger is written only after the upload has been accepted, so a
    # crash mid-push leaves the run repeatable rather than half-recorded.
    now = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    shard = files[0][1]
    ledger.executemany(
        "INSERT OR IGNORE INTO published (game_id, shard, published_at_unix_ms)"
        " VALUES (?, ?, ?)",
        [(record["game_id"], shard, now) for record in fresh],
    )
    ledger.commit()
    print(f"published {len(fresh)} game(s) to {args.repo} as {args.date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
