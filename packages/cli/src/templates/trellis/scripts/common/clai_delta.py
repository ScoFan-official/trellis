#!/usr/bin/env python3
"""CLAI fork delta — domain-board mechanics collected in one module.

This file is the single place the CLAI (ClaiDevSkill) fork diverges from
upstream Trellis in script logic. Call sites stay thin: one or two lines in
`task.py` (start gate / finish warn), `common/task_store.py` (create sugar /
archive warn), `common/task_context.py` (validate reconcile), and
`common/session_context.py` (context rendering) delegate here.

CLAI DELTA LIST (numbered for the contract document — when an upstream
`trellis update` conflicts, reconcile against this list item by item):

    CLAI-1  task.py create/start --domain <slug>
            Sugar for a `meta.domain` write on the task (same effect as
            `--meta domain=<slug>` on create or `set-meta` before start).
    CLAI-2  task.py start flag gate
            When the task's meta.domain resolves to a domain board whose
            README first line carries a FRESH FOREIGN construction flag
            (旗行), start is refused with the flag reported. Own flag or a
            stale flag (>24h) proceeds. This is the only mechanical gate in
            the flag protocol — flag insertion/removal itself stays manual.
    CLAI-3  task.py validate domain ↔ REGISTRY reconciliation
            Every directory under .trellis/domains/ (except _scaffold) must
            have a REGISTRY.md line, and every REGISTRY line must resolve to
            an existing directory. Mismatches fail validate.
    CLAI-4  task.py finish/archive own-flag warning
            If the finished/archived task's domain board still carries THIS
            writer's flag, warn (旗未拔) — never auto-delete, never block.
    CLAI-5  get_context 当前战线 (battle lines) section
            One line per REGISTRY-registered board: slug, purpose, flag
            status, progress row count.
    CLAI-6  get_context 当前模式 (autonomy) line
            Reads .trellis/config.yaml `autonomy:`; `gated` | `hands-off`,
            default hands-off when the key is absent or unrecognized.

Writer identity (own-writer matching): `TRELLIS_WRITER` env var wins;
otherwise `devin-<hostname>` — the convention used by Devin agents in
dogfood. A flag's writer field is an opaque string compared by equality.
"""

from __future__ import annotations

import os
import re
import socket
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .io import read_json_checked, write_json
from .log import Colors, colored
from .paths import DIR_WORKFLOW
from .trellis_config import read_trellis_config


# =============================================================================
# Constants
# =============================================================================

# Env override for the writer identity stamped into flag lines. Mirrors the
# TRELLIS_DEVELOPER pattern: env first, convention-derived default after.
ENV_WRITER = "TRELLIS_WRITER"

DIR_DOMAINS = "domains"
SCAFFOLD_DIR = "_scaffold"  # skeleton template — not a board, exempt everywhere
FILE_REGISTRY = "REGISTRY.md"
FILE_BOARD_README = "README.md"

DEFAULT_AUTONOMY = "hands-off"
KNOWN_AUTONOMY = {"gated", "hands-off"}

# A foreign flag older than this is 腐旗 (stale) — start proceeds; the flag
# protocol's three-anchor evidence rules decide whether it may be replaced.
STALE_FLAG_AGE = timedelta(hours=24)

_DOMAIN_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
_REGISTRY_LINE_RE = re.compile(r"^([a-z0-9][a-z0-9-]*)/\s*—\s*(.*)$")
_FLAG_PREFIXES = ("旗:", "旗：")
_FLAG_SEPARATOR = " · "
_FLAG_SINCE_RE = re.compile(r"自\s*(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})")


# =============================================================================
# Writer identity + slug validation (CLAI-1/2/4 shared)
# =============================================================================

def own_writer_id() -> str:
    """Return this session's writer identity for flag ownership checks.

    `TRELLIS_WRITER` wins (explicit identity, and the deterministic fixture
    knob); otherwise `devin-<hostname>` — the Devin dogfood convention.
    """
    override = os.environ.get(ENV_WRITER, "").strip()
    if override:
        return override
    return f"devin-{socket.gethostname()}"


def domain_slug_ok(slug: object) -> bool:
    """Mechanical slug rule — same shape REGISTRY.md prescribes."""
    return isinstance(slug, str) and bool(_DOMAIN_SLUG_RE.fullmatch(slug))


def board_dir_for(repo_root: Path, slug: object) -> Path | None:
    """Resolve meta.domain to a board dir, or None when it is not one.

    Returns None for malformed slugs, `_scaffold`, and slugs whose directory
    does not exist — "resolves to a domain board" is false in all three.
    """
    if not domain_slug_ok(slug) or slug == SCAFFOLD_DIR:
        return None
    board = Path(repo_root) / DIR_WORKFLOW / DIR_DOMAINS / str(slug)
    return board if board.is_dir() else None


# =============================================================================
# Flag line parsing (CLAI-2/4/5)
# =============================================================================

@dataclass
class DomainFlag:
    """Parsed board README flag line.

    `well_formed` is False when the line starts with 旗 but does not parse —
    an unverifiable flag is treated as foreign for safety (cannot prove it
    is ours or stale, so it blocks like a fresh foreign flag).
    """

    raw: str
    writer: str
    context: str
    since: datetime | None

    @property
    def well_formed(self) -> bool:
        return bool(self.writer) and self.since is not None

    @property
    def since_text(self) -> str:
        return self.since.strftime("%Y-%m-%d %H:%M") if self.since else "?"


def parse_flag_line(line: str) -> DomainFlag | None:
    """Parse `旗: <writer> · <context> · 自 <YYYY-MM-DD HH:mm>`; None if absent."""
    text = line.strip()
    for prefix in _FLAG_PREFIXES:
        if not text.startswith(prefix):
            continue
        body = text[len(prefix):].strip()
        parts = [p.strip() for p in body.split(_FLAG_SEPARATOR)]
        writer = parts[0] if parts and parts[0] else ""
        context = parts[1] if len(parts) > 1 else ""
        since = None
        match = _FLAG_SINCE_RE.search(body)
        if match:
            try:
                since = datetime.strptime(
                    f"{match.group(1)} {match.group(2)}", "%Y-%m-%d %H:%M"
                )
            except ValueError:
                since = None
        return DomainFlag(raw=line.rstrip("\n"), writer=writer,
                          context=context, since=since)
    return None


def read_board_flag(board_dir: Path) -> DomainFlag | None:
    """Read the flag from a board README's first line (head -1 直读)."""
    readme = Path(board_dir) / FILE_BOARD_README
    try:
        with readme.open("r", encoding="utf-8") as fh:
            first = fh.readline()
    except OSError:
        return None
    return parse_flag_line(first)


def flag_kind(
    flag: DomainFlag | None,
    own: str | None = None,
    now: datetime | None = None,
) -> str:
    """Classify a flag: none | own | fresh_foreign | stale_foreign | unknown.

    `unknown` covers unparsable 旗 lines — treated as foreign by callers.
    """
    if flag is None:
        return "none"
    if own is None:
        own = own_writer_id()
    if flag.writer and flag.writer == own:
        return "own"
    if not flag.well_formed:
        return "unknown"
    now = now or datetime.now()
    if now - flag.since > STALE_FLAG_AGE:  # type: ignore[operator]
        return "stale_foreign"
    return "fresh_foreign"


# =============================================================================
# CLAI-1/2 — task meta.domain sugar + start flag gate
# =============================================================================

def read_task_domain(task_json_path: Path) -> str | None:
    """Return meta.domain from a task.json, or None when absent/unreadable."""
    data, _reason = read_json_checked(task_json_path)
    if not isinstance(data, dict):
        return None
    meta = data.get("meta")
    if not isinstance(meta, dict):
        return None
    domain = meta.get("domain")
    return domain.strip() if isinstance(domain, str) and domain.strip() else None


def set_task_domain(task_json_path: Path, slug: str) -> bool:
    """Write meta.domain=<slug> into task.json (set-meta equivalent). CLAI-1."""
    path = Path(task_json_path)
    if not domain_slug_ok(slug):
        print(
            colored(
                f"Error: --domain must be a lowercase board slug "
                f"(a-z, 0-9, '-'): {slug}",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        return False
    if not path.is_file():
        print(
            colored(f"Error: task.json not found at {path.parent}", Colors.RED),
            file=sys.stderr,
        )
        return False
    data, reason = read_json_checked(path)
    if data is None:
        print(
            colored(f"Error: could not read {path.name}: {reason}", Colors.RED),
            file=sys.stderr,
        )
        return False
    meta = data.get("meta")
    if not isinstance(meta, dict):
        meta = {}
    meta["domain"] = slug
    data["meta"] = meta
    if not write_json(path, data):
        print(
            colored(f"Error: could not write {path}", Colors.RED),
            file=sys.stderr,
        )
        return False
    return True


def flag_conflict(
    repo_root: Path,
    slug: str | None,
    own: str | None = None,
    now: datetime | None = None,
) -> DomainFlag | None:
    """Return the flag blocking `start` on the task's domain board, or None.

    Blocks on fresh foreign flags and unparsable 旗 lines (ownership cannot
    be verified). Own flag, stale flag (>24h), missing board/README/flag all
    proceed — a stale flag is reported on stderr as advisory.
    """
    board = board_dir_for(repo_root, slug)
    if board is None:
        return None
    flag = read_board_flag(board)
    kind = flag_kind(flag, own=own, now=now)
    if kind in ("fresh_foreign", "unknown"):
        return flag
    if kind == "stale_foreign" and flag is not None:
        print(
            colored(
                f"Note: 板块 {slug} 旗已腐（>{int(STALE_FLAG_AGE.total_seconds() // 3600)}h）"
                f"——start 放行；如需代拔走三锚点自查流程。",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
    return None


# =============================================================================
# CLAI-4 — finish/archive own-flag warning (never deletes, never blocks)
# =============================================================================

def warn_if_own_flag(
    repo_root: Path,
    task_json_path: Path,
    own: str | None = None,
) -> None:
    """Warn when the task's domain board still carries OUR flag (旗未拔)."""
    slug = read_task_domain(task_json_path)
    board = board_dir_for(repo_root, slug)
    if board is None:
        return
    flag = read_board_flag(board)
    if flag_kind(flag, own=own) == "own" and flag is not None:
        print(
            colored(
                f"Warning: 旗未拔——板块 {slug} 首行仍是本写者施工旗"
                f"（{flag.writer}）。按收工一单制在收工 commit 里手动删旗行；"
                f"本命令不代拔。",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )


# =============================================================================
# CLAI-3 — domains/ dir ↔ REGISTRY.md reconciliation
# =============================================================================

def registry_entries(repo_root: Path) -> list[tuple[str, str]]:
    """Parse REGISTRY.md board lines into (slug, purpose) pairs, in order."""
    registry = Path(repo_root) / DIR_WORKFLOW / DIR_DOMAINS / FILE_REGISTRY
    try:
        text = registry.read_text(encoding="utf-8")
    except OSError:
        return []
    entries: list[tuple[str, str]] = []
    for line in text.splitlines():
        match = _REGISTRY_LINE_RE.match(line.strip())
        if match:
            entries.append((match.group(1), match.group(2).strip()))
    return entries


def reconcile_domain_registry(repo_root: Path) -> list[str]:
    """Return reconciliation error strings (empty list = clean). CLAI-3.

    Bidirectional: every domains/ dir (except _scaffold) needs a REGISTRY
    line, and every REGISTRY line needs an existing dir.
    """
    domains_dir = Path(repo_root) / DIR_WORKFLOW / DIR_DOMAINS
    if not domains_dir.is_dir():
        return []

    dirs = {d.name for d in domains_dir.iterdir()
            if d.is_dir() and d.name != SCAFFOLD_DIR}
    registered = {slug for slug, _purpose in registry_entries(repo_root)}

    problems: list[str] = []
    for name in sorted(dirs - registered):
        problems.append(
            f"domains/{name}/ has no REGISTRY.md line — "
            "register the board or remove the directory."
        )
    for slug in sorted(registered - dirs):
        problems.append(
            f"REGISTRY.md line '{slug}/' points at no existing board directory."
        )
    return problems


# =============================================================================
# CLAI-5/6 — get_context battle lines + autonomy mode
# =============================================================================

def read_autonomy(repo_root: Path) -> str:
    """Read config.yaml `autonomy:`; unknown/absent → hands-off. CLAI-6."""
    # read_trellis_config already collapses missing/malformed to {}.
    config = read_trellis_config(repo_root)
    value = config.get("autonomy")
    if isinstance(value, str) and value.strip() in KNOWN_AUTONOMY:
        return value.strip()
    return DEFAULT_AUTONOMY


def _progress_row_count(readme: Path) -> int:
    """Count data rows in the board README's `## 进度` table.

    Data rows = `|...|` lines in that section minus the header and the
    `|---|` separator rows.
    """
    try:
        text = readme.read_text(encoding="utf-8")
    except OSError:
        return 0
    in_section = False
    seen_table_row = False
    count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_section = stripped.startswith("## 进度")
            seen_table_row = False
            continue
        if not in_section:
            continue
        if stripped.startswith("|") and stripped.endswith("|"):
            if set(stripped) <= set("|-: "):
                continue  # separator row
            if not seen_table_row:
                seen_table_row = True  # header row
                continue
            count += 1
    return count


def _flag_status_text(
    flag: DomainFlag | None,
    own: str | None = None,
    now: datetime | None = None,
) -> str:
    kind = flag_kind(flag, own=own, now=now)
    if flag is None or kind == "none":
        return "无旗"
    if kind == "own":
        return f"自己旗 {flag.writer}（自 {flag.since_text}）"
    if kind == "stale_foreign":
        return f"腐旗 {flag.writer}（自 {flag.since_text}，>24h）"
    if kind == "fresh_foreign":
        return f"他人旗 {flag.writer}（自 {flag.since_text}）"
    return f"旗行无法解析: {flag.raw}"


def battle_lines(
    repo_root: Path,
    own: str | None = None,
    now: datetime | None = None,
) -> list[str]:
    """Build the 当前战线 section lines. CLAI-5.

    Emitted only when the domains layer exists in this repo; each
    REGISTRY-registered board gets one line with flag status and progress
    row count.
    """
    domains_dir = Path(repo_root) / DIR_WORKFLOW / DIR_DOMAINS
    if not domains_dir.is_dir():
        return []

    entries = registry_entries(repo_root)
    lines = ["## 当前战线 (BATTLE LINES)"]
    if not entries:
        lines.append("  （REGISTRY 无登记板块）")
        return lines

    for slug, purpose in entries:
        board = domains_dir / slug
        suffix = f" — {purpose}" if purpose else ""
        if board.is_dir():
            flag = read_board_flag(board)
            status = _flag_status_text(flag, own=own, now=now)
            progress = _progress_row_count(board / FILE_BOARD_README)
            lines.append(f"  {slug}/{suffix}")
            lines.append(f"    旗位: {status} · 进度: {progress} 项")
        else:
            lines.append(f"  {slug}/{suffix}  ⚠ 板块目录缺失（对账违规）")
    return lines


def append_domain_context(lines: list[str], repo_root: Path) -> None:
    """Append CLAI-5/6 context output onto `lines` (thin call-site helper)."""
    lines.append("## 当前模式 (AUTONOMY)")
    lines.append(read_autonomy(repo_root))
    lines.append("")
    section = battle_lines(repo_root)
    if section:
        lines.extend(section)
        lines.append("")
