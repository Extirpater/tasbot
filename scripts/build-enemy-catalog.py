#!/usr/bin/env python3
"""Extract public enemy data without executing the downloaded client."""
import argparse
import ast
import hashlib
import json
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=Path)
parser.add_argument("--url")
parser.add_argument("--output", type=Path, default=Path("data/enemies.json"))
parser.add_argument("--directory", type=Path, default=Path("docs/enemy-types.md"))
args = parser.parse_args()
url = args.url
if args.source:
    source = args.source.read_text()
else:
    with urllib.request.urlopen("https://evades.io/", timeout=20) as response:
        html = response.read().decode()
    scripts = re.findall(r'<script[^>]+src=["\']([^"\']+)', html)
    url = urllib.parse.urljoin("https://evades.io/", next(s for s in scripts if s.startswith("/index")))
    with urllib.request.urlopen(url, timeout=20) as response:
        source = response.read().decode()

enum = re.search(r"\bEntityType:\{([A-Z0-9_:,]+)\}", source).group(1)
types = re.findall(r"([A-Z0-9_]+):(\d+)", enum)
config_at = source.rfind("JSON.parse(", 0, source.index('"normal_enemy"'))
literal = re.match(r"JSON\.parse\(('(?:[^'\\]|\\.)*')\)", source[config_at:]).group(1)
config = json.loads(ast.literal_eval(literal))
schemas = {
    name: json.loads(fields)
    for name, fields in re.findall(r'(\w+):\{fields:(\[[^\]]*\]),message:"Entity",name:"\w+"\}', source)
}
entries = []
for name, number in types:
    if not name.endswith(("_ENEMY", "_PROJECTILE")):
        continue
    key = name.lower()
    class_name = "".join(word.title() for word in key.split("_"))
    specific = schemas.get(class_name)
    base_name = "Enemy" if name.endswith("_ENEMY") else "EnemyProjectile"
    base = schemas.get(base_name, [])
    entries.append({
        "id": int(number), "name": key,
        "defaults": config.get("defaults", {}).get(key, {}),
        "telemetryFields": specific if specific is not None else base,
        "telemetrySchema": class_name if specific is not None else (base_name if base else None),
    })
result = {
    "source": url,
    "retrievedAt": datetime.now(timezone.utc).isoformat(),
    "sha256": hashlib.sha256(source.encode()).hexdigest(),
    "serverTickRate": config.get("server_tick_rate"),
    "note": "Public client defaults and available telemetry only. Area overrides and complete server behavior are not included. Player projectiles are listed too; live isEnemy/isEnemyProjectile flags determine threats.",
    "entities": entries,
}
args.output.parent.mkdir(parents=True, exist_ok=True)
args.output.write_text(json.dumps(result, indent=2) + "\n")
directory = [
    "# Public enemy and projectile directory", "",
    f"Generated from [{url or 'local client source'}]({url or '../data/enemies.json'}).",
    "Default properties are overridden by live areas. Missing defaults mean unavailable, not zero.",
    "See [coverage and refresh instructions](enemy-catalog.md) and [all telemetry fields](../data/enemies.json).", "",
    "| ID | Type | Default properties | Telemetry schema |",
    "| --- | --- | --- | --- |",
]
for entry in entries:
    properties = ", ".join(f"{key}: {json.dumps(value, ensure_ascii=False)}" for key, value in entry["defaults"].items())
    directory.append(f"| {entry['id']} | {entry['name']} | {properties or 'unavailable'} | {entry['telemetrySchema'] or 'unavailable'} |")
args.directory.parent.mkdir(parents=True, exist_ok=True)
args.directory.write_text("\n".join(directory) + "\n")
print(f"Wrote {len(entries)} enemy/projectile types to {args.output}")
print(f"Wrote readable directory to {args.directory}")
