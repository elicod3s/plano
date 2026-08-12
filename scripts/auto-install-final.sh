#!/bin/bash
# AUTO-INSTALL the final PLANO build over the installed app, then auto-resume this
# conversation (pi --session) in the fresh install. Runs fully detached.
#
# Sequence (all automatic):
#   1. grace sleep (lets the running pi finish rendering its final message)
#   2. stop the Agent Host daemon (releases the lock on the installed app.asar; the
#      conversation's session file is persisted incrementally and complete)
#   3. stop the orphaned pi conversation process
#   4. stop the dev app (electron) — releases the single-instance lock + stops autosaves
#   5. wait for the installed app.asar to unlock
#   6. back up the old install, copy the new win-unpacked, verify (sizes + content marker)
#   7. patch <userData>/workspaces.json so this conversation's terminal tab boots
#      `pi --session 019fd394-b84e-70c8-bf99-559c6f7c81dd` on the next launch
#   8. launch the new PLANO; the workspace restores and the conversation resumes
#   9. verify a resumed pi process is running
# Rollback: if the copy/verify fails, the previous install is moved back.

LOG="D:/Tools/Plano/.plano/install-final.log"
SRC="D:/Tools/Plano/release/win-unpacked"
DST="C:/Users/Administrator/AppData/Local/Programs/PLANO"
WS="C:/Users/Administrator/AppData/Roaming/plano/workspaces.json"
SESSION="019fd394-b84e-70c8-bf99-559c6f7c81dd"
TAB_ID="7-JnDmq_Dw"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

log "=== auto-install started (grace 90s) ==="
sleep 90

# ── 2. stop the Agent Host daemon ────────────────────────────────────────────
HOST_PID=$(python -c "import json;print(json.load(open('C:/Users/Administrator/AppData/Roaming/plano/agent-host.json'))['pid'])" 2>/dev/null)
if [ -n "$HOST_PID" ]; then
  if taskkill //F //PID "$HOST_PID" >>"$LOG" 2>&1; then log "daemon $HOST_PID stopped"; else log "daemon $HOST_PID already gone"; fi
fi
sleep 3

# ── 3. stop the orphaned pi conversation process (session already persisted) ──
# The old pi's cmdline has no session id, so match any pi-coding-agent CLI process
# (at this point the only ones alive are orphans of the daemon we just stopped).
CONV_PIDS=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -match 'pi-coding-agent' } | ForEach-Object { \$_.ProcessId }" 2>/dev/null | tr -d '\r')
if [ -n "$CONV_PIDS" ]; then
  for p in $CONV_PIDS; do taskkill //F //PID "$p" >>"$LOG" 2>&1 && log "conversation pi $p stopped"; done
else
  log "no orphaned pi processes found"
fi
sleep 2

# ── 4. stop the dev app (all electron.exe are the dev app here) ─────────────
for pid in $(tasklist //FI "IMAGENAME eq electron.exe" //FO CSV //NH 2>/dev/null | cut -d',' -f2 | tr -d '"' ); do
  [ -n "$pid" ] && taskkill //F //T //PID "$pid" >>"$LOG" 2>&1 && log "dev electron $pid stopped"
done
# also stop the vite dev server (node running electron-vite)
for pid in $(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -match 'electron-vite' } | ForEach-Object { \$_.ProcessId }" 2>/dev/null | tr -d '\r'); do
  [ -n "$pid" ] && taskkill //F //PID "$pid" >>"$LOG" 2>&1 && log "vite dev server $pid stopped"
done
sleep 3

# ── 5. wait for the installed app.asar lock to release ─────────────────────
for i in $(seq 1 60); do
  if powershell -NoProfile -Command "try { \$s=[IO.File]::Open('$DST/resources/app.asar','Open','ReadWrite','None'); \$s.Close(); exit 1 } catch { exit 0 }" 2>/dev/null; then
    log "app.asar unlocked after ${i}s"
    break
  fi
  if [ "$i" = 60 ]; then log "FATAL: app.asar still locked"; exit 1; fi
  sleep 1
done

# ── 6. back up + copy + verify ──────────────────────────────────────────────
STAMP=$(date +%Y%m%d-%H%M%S)
if ! mv "$DST" "$DST.previous-$STAMP" >>"$LOG" 2>&1; then log "FATAL: cannot move old install (still locked?)"; exit 1; fi
log "old install backed up -> $DST.previous-$STAMP"
if ! cp -rf "$SRC/." "$DST" >>"$LOG" 2>&1; then
  log "FATAL: copy failed — rolling back"
  rm -rf "$DST"
  mv "$DST.previous-$STAMP" "$DST" 2>/dev/null
  exit 1
fi
log "copied $SRC -> $DST"

# verify: sizes + new-code marker in the asar
if [ "$(stat -c %s "$SRC/PLANO.exe")" != "$(stat -c %s "$DST/PLANO.exe")" ] ||
   [ "$(stat -c %s "$SRC/resources/app.asar")" != "$(stat -c %s "$DST/resources/app.asar")" ] ||
   ! grep -q "Agent finished sound" "$DST/resources/app.asar"; then
  log "FATAL: verification failed — rolling back"
  rm -rf "$DST"
  mv "$DST.previous-$STAMP" "$DST" 2>/dev/null
  exit 1
fi
log "verify OK: exe+asar sizes match, new-code marker present"

# ── 7. patch workspaces.json: this conversation's tab boots pi --session ────
python - "$WS" "$TAB_ID" "$SESSION" <<'PY' >>"$LOG" 2>&1
import sys, json
path, tab_id, session = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(path, encoding='utf8').read()
needle = '"id": "' + tab_id + '",'
boot = '"id": "' + tab_id + '",\n                "bootCommand": "pi --session ' + session + '",'
if needle in raw and 'bootCommand' not in raw.split(tab_id, 1)[1][:300]:
    raw = raw.replace(needle, boot, 1)
    json.loads(raw)  # validate before writing
    open(path, 'w', encoding='utf8').write(raw)
    print('workspaces.json patched: bootCommand added to tab ' + tab_id)
else:
    print('workspaces.json: already patched or tab not found')
PY

# ── 8. launch the new app ────────────────────────────────────────────────────
powershell -NoProfile -Command "Start-Process -FilePath '$DST\\PLANO.exe'" >>"$LOG" 2>&1
log "launched new PLANO ($DST/PLANO.exe)"

# ── 9. verify the conversation resumes ───────────────────────────────────────
sleep 25
RESUMED=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -match '$SESSION' } | Measure-Object | Select-Object -ExpandProperty Count" 2>/dev/null | tr -d '\r')
if [ -n "$RESUMED" ] && [ "$RESUMED" -ge 1 ]; then
  log "RESUME OK: pi --session $SESSION process detected ($RESUMED)"
else
  log "WARNING: no resumed pi process detected yet (check manually)"
fi

log "=== auto-install finished ==="
