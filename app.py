import os
import re
import time
import uuid
import shutil
import secrets
import threading
from pathlib import Path
from flask import Flask, render_template, request, jsonify, send_file, abort
from flask_socketio import SocketIO, join_room, leave_room, emit

BASE_DIR = Path(__file__).resolve().parent
STORAGE_DIR = Path(os.environ.get("STORAGE_DIR", BASE_DIR / "storage"))
UPLOAD_DIR = STORAGE_DIR / "uploads"
TEMP_DIR = STORAGE_DIR / "temp"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
TEMP_DIR.mkdir(parents=True, exist_ok=True)

MAX_VIDEO_BYTES = 3 * 1024 * 1024 * 1024
SESSION_TTL = int(os.environ.get("UPLOAD_SESSION_TTL", 12 * 60 * 60))
ROOM_TTL = int(os.environ.get("ROOM_TTL", 6 * 60 * 60))

ALLOWED_EXT = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"}
ALLOWED_MIME_PREFIXES = ("video/",)

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", secrets.token_hex(32))
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="gevent",
    max_http_buffer_size=1024 * 1024 * 1024,
)

rooms = {}
uploads = {}
lock = threading.RLock()


def safe_name(name):
    name = Path(name or "video").name
    stem = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).stem)[:80] or "video"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        ext = ".mp4"
    return stem + ext


def new_room_id():
    while True:
        rid = "WATCH-" + secrets.token_hex(3).upper()
        if rid not in rooms:
            return rid


def cleanup_loop():
    while True:
        time.sleep(300)
        now = time.time()
        with lock:
            for uid, info in list(uploads.items()):
                if now - info["updated"] > SESSION_TTL:
                    shutil.rmtree(TEMP_DIR / uid, ignore_errors=True)
                    uploads.pop(uid, None)

            for rid, room in list(rooms.items()):
                if now - room["updated"] > ROOM_TTL and not room["sids"]:
                    if room.get("filename"):
                        try:
                            (UPLOAD_DIR / room["filename"]).unlink(missing_ok=True)
                        except Exception:
                            pass
                    rooms.pop(rid, None)


threading.Thread(target=cleanup_loop, daemon=True).start()


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify(ok=True, service="watch-together")


@app.post("/api/create-room")
def create_room():
    rid = new_room_id()
    with lock:
        rooms[rid] = {
            "created": time.time(),
            "updated": time.time(),
            "filename": None,
            "original_name": None,
            "duration": 0,
            "position": 0,
            "playing": False,
            "sids": set(),
            "call_sids": set(),
            "mic_muted": {},
        }
    return jsonify(room_id=rid)


@app.get("/api/room/<room_id>")
def room_info(room_id):
    with lock:
        room = rooms.get(room_id)
        if not room:
            return jsonify(error="Room not found or expired"), 404
        return jsonify(
            room_id=room_id,
            filename=room["filename"],
            original_name=room["original_name"],
            playing=room["playing"],
            position=room["position"],
            duration=room["duration"],
            viewers=len(room["sids"]),
        )


@app.post("/api/upload/start")
def upload_start():
    data = request.get_json(silent=True) or {}
    room_id = str(data.get("room_id", "")).upper()
    name = safe_name(data.get("filename", "video.mp4"))
    size = int(data.get("size", 0))
    mime = str(data.get("mime", "video/mp4"))

    with lock:
        if room_id not in rooms:
            return jsonify(error="Room not found"), 404
        if size <= 0 or size > MAX_VIDEO_BYTES:
            return jsonify(error="Video must be between 1 byte and 3 GiB"), 400
        if not mime.startswith(ALLOWED_MIME_PREFIXES) and Path(name).suffix.lower() not in ALLOWED_EXT:
            return jsonify(error="Unsupported video type"), 400

        old = rooms[room_id].get("filename")
        if old:
            (UPLOAD_DIR / old).unlink(missing_ok=True)

        uid = uuid.uuid4().hex
        (TEMP_DIR / uid).mkdir(parents=True, exist_ok=True)
        uploads[uid] = {
            "room_id": room_id,
            "filename": name,
            "size": size,
            "mime": mime,
            "updated": time.time(),
        }

    return jsonify(upload_id=uid, max_size=MAX_VIDEO_BYTES)


@app.get("/api/upload/<upload_id>/status")
def upload_status(upload_id):
    with lock:
        info = uploads.get(upload_id)
        if not info:
            return jsonify(error="Upload session not found"), 404

        folder = TEMP_DIR / upload_id
        ranges = []
        received = 0
        for p in folder.glob("*.part"):
            try:
                start, end = map(int, p.stem.split("-"))
                length = end - start + 1
                if length > 0:
                    ranges.append({"start": start, "end": end})
                    received += length
            except Exception:
                continue

        ranges.sort(key=lambda x: x["start"])
        return jsonify(size=info["size"], received=received, ranges=ranges)


@app.put("/api/upload/<upload_id>/chunk")
def upload_chunk(upload_id):
    with lock:
        info = uploads.get(upload_id)
    if not info:
        return jsonify(error="Upload session not found"), 404

    try:
        start = int(request.headers.get("X-Chunk-Start", "-1"))
        end = int(request.headers.get("X-Chunk-End", "-1"))
        total = int(request.headers.get("X-Upload-Total", "-1"))
    except ValueError:
        return jsonify(error="Invalid chunk headers"), 400

    if total != info["size"] or start < 0 or end < start or end >= total:
        return jsonify(error="Invalid byte range"), 400

    expected = end - start + 1
    content_length = request.content_length
    if content_length is not None and content_length != expected:
        return jsonify(error=f"Chunk length mismatch: expected {expected}, got {content_length}"), 400

    folder = TEMP_DIR / upload_id
    folder.mkdir(parents=True, exist_ok=True)
    part = folder / f"{start}-{end}.part"
    temp_part = folder / f"{start}-{end}.uploading"

    try:
        with open(temp_part, "wb") as f:
            remaining = expected
            while remaining:
                block = request.stream.read(min(4 * 1024 * 1024, remaining))
                if not block:
                    break
                f.write(block)
                remaining -= len(block)
            if remaining:
                temp_part.unlink(missing_ok=True)
                return jsonify(error="Incomplete chunk received"), 400
        os.replace(temp_part, part)
    except Exception as e:
        temp_part.unlink(missing_ok=True)
        return jsonify(error=f"Could not save chunk: {e}"), 500

    with lock:
        info["updated"] = time.time()
    return jsonify(ok=True, start=start, end=end)


@app.post("/api/upload/<upload_id>/complete")
def upload_complete(upload_id):
    with lock:
        info = uploads.get(upload_id)
    if not info:
        return jsonify(error="Upload session not found"), 404

    folder = TEMP_DIR / upload_id
    ranges = []
    for p in folder.glob("*.part"):
        try:
            start, end = map(int, p.stem.split("-"))
            ranges.append((start, end, p))
        except Exception:
            pass

    ranges.sort()
    cursor = 0
    for start, end, _ in ranges:
        if start != cursor:
            return jsonify(error=f"Upload incomplete at byte {cursor}"), 400
        cursor = end + 1

    if cursor != info["size"]:
        return jsonify(error=f"Upload incomplete: {cursor}/{info['size']} bytes"), 400

    final_name = f"{uuid.uuid4().hex}_{safe_name(info['filename'])}"
    final_path = UPLOAD_DIR / final_name
    tmp_final = UPLOAD_DIR / f".{final_name}.assembling"

    try:
        with open(tmp_final, "wb") as out:
            for _, _, p in ranges:
                with open(p, "rb") as src:
                    shutil.copyfileobj(src, out, length=4 * 1024 * 1024)
        os.replace(tmp_final, final_path)
        shutil.rmtree(folder, ignore_errors=True)
    except Exception as e:
        tmp_final.unlink(missing_ok=True)
        return jsonify(error=f"Assembly failed: {e}"), 500

    rid = info["room_id"]
    with lock:
        room = rooms.get(rid)
        if room:
            room["filename"] = final_name
            room["original_name"] = info["filename"]
            room["position"] = 0
            room["playing"] = False
            room["updated"] = time.time()
        uploads.pop(upload_id, None)

    socketio.emit(
        "video_ready",
        {"filename": final_name, "original_name": info["filename"]},
        to=rid,
    )

    return jsonify(ok=True, filename=final_name, original_name=info["filename"])


@app.delete("/api/upload/<upload_id>")
def upload_cancel(upload_id):
    with lock:
        uploads.pop(upload_id, None)
    shutil.rmtree(TEMP_DIR / upload_id, ignore_errors=True)
    return jsonify(ok=True)


@app.get("/media/<path:filename>")
def media(filename):
    filename = Path(filename).name
    path = UPLOAD_DIR / filename
    if not path.exists() or not path.is_file():
        abort(404)
    return send_file(path, conditional=True, etag=True, max_age=3600)


def room_snapshot(rid):
    room = rooms.get(rid)
    if not room:
        return None
    return {
        "filename": room["filename"],
        "original_name": room["original_name"],
        "playing": room["playing"],
        "position": room["position"],
        "duration": room["duration"],
        "viewers": len(room["sids"]),
    }


def emit_call_audio_state(rid):
    with lock:
        room = rooms.get(rid)
        if not room:
            return
        active = list(room["call_sids"])
        any_unmuted = any(not room["mic_muted"].get(sid, True) for sid in active)
        states = [
            {"sid": sid, "muted": room["mic_muted"].get(sid, True)}
            for sid in active
        ]
    socketio.emit(
        "call_audio_state",
        {"any_unmuted": any_unmuted, "states": states},
        to=rid,
    )


@socketio.on("join")
def on_join(data):
    rid = str(data.get("room_id", "")).upper()
    with lock:
        room = rooms.get(rid)
        if not room:
            emit("error_message", {"message": "Room not found or expired"})
            return
        join_room(rid)
        room["sids"].add(request.sid)
        room["updated"] = time.time()
        state = room_snapshot(rid)

    emit("room_state", state)
    socketio.emit("viewer_count", {"count": state["viewers"]}, to=rid)


@socketio.on("disconnect")
def on_disconnect():
    affected = []
    with lock:
        for rid, room in rooms.items():
            if request.sid in room["sids"]:
                room["sids"].discard(request.sid)
                room["call_sids"].discard(request.sid)
                room["mic_muted"].pop(request.sid, None)
                room["updated"] = time.time()
                affected.append((rid, len(room["sids"])))
                break

    for rid, count in affected:
        socketio.emit("viewer_count", {"count": count}, to=rid)
        socketio.emit("call_peer_left", {"sid": request.sid}, to=rid)
        emit_call_audio_state(rid)


def require_room(data):
    rid = str(data.get("room_id", "")).upper()
    with lock:
        if rid not in rooms:
            emit("error_message", {"message": "Room not found"})
            return None
        rooms[rid]["updated"] = time.time()
    return rid


@socketio.on("play")
def on_play(data):
    rid = require_room(data)
    if not rid:
        return
    pos = float(data.get("position", 0))
    with lock:
        rooms[rid]["playing"] = True
        rooms[rid]["position"] = pos
    emit("sync_play", {"position": pos}, to=rid, include_self=False)


@socketio.on("pause")
def on_pause(data):
    rid = require_room(data)
    if not rid:
        return
    pos = float(data.get("position", 0))
    with lock:
        rooms[rid]["playing"] = False
        rooms[rid]["position"] = pos
    emit("sync_pause", {"position": pos}, to=rid, include_self=False)


@socketio.on("seek")
def on_seek(data):
    rid = require_room(data)
    if not rid:
        return
    pos = float(data.get("position", 0))
    with lock:
        rooms[rid]["position"] = pos
    emit("sync_seek", {"position": pos}, to=rid, include_self=False)


@socketio.on("time_update")
def on_time_update(data):
    rid = require_room(data)
    if not rid:
        return
    with lock:
        rooms[rid]["position"] = float(data.get("position", 0))


@socketio.on("duration")
def on_duration(data):
    rid = require_room(data)
    if not rid:
        return
    with lock:
        rooms[rid]["duration"] = float(data.get("duration", 0))


@socketio.on("chat")
def on_chat(data):
    rid = require_room(data)
    if not rid:
        return
    msg = str(data.get("message", "")).strip()[:500]
    name = str(data.get("name", "Guest")).strip()[:40] or "Guest"
    if msg:
        emit(
            "chat_message",
            {"name": name, "message": msg, "time": time.strftime("%H:%M")},
            to=rid,
        )


@socketio.on("reaction")
def on_reaction(data):
    rid = require_room(data)
    if not rid:
        return
    emoji = str(data.get("emoji", ""))[:8]
    emit("reaction", {"emoji": emoji}, to=rid)


# ---------- WebRTC call signalling (browser-to-browser media) ----------

@socketio.on("call_join")
def on_call_join(data):
    rid = require_room(data)
    if not rid:
        return

    with lock:
        room = rooms[rid]
        room["call_sids"] = {sid for sid in room["call_sids"] if sid in room["sids"]}
        if request.sid in room["call_sids"]:
            return

        if len(room["call_sids"]) >= 2:
            emit("call_error", {"message": "This room already has two people in the video call."})
            return

        existing = next(iter(room["call_sids"]), None)
        room["call_sids"].add(request.sid)
        room["mic_muted"][request.sid] = True

    if existing:
        emit("call_peer", {"sid": existing, "initiator": False}, to=request.sid)
        emit("call_peer", {"sid": request.sid, "initiator": True}, to=existing)

    socketio.emit(
        "call_count",
        {"count": len(rooms[rid]["call_sids"])},
        to=rid,
    )
    emit_call_audio_state(rid)


@socketio.on("call_mute")
def on_call_mute(data):
    rid = require_room(data)
    if not rid:
        return

    muted = bool(data.get("muted", True))
    with lock:
        room = rooms[rid]
        if request.sid not in room["call_sids"]:
            return
        room["mic_muted"][request.sid] = muted

    emit_call_audio_state(rid)


@socketio.on("call_leave")
def on_call_leave(data):
    rid = require_room(data)
    if not rid:
        return

    with lock:
        room = rooms[rid]
        room["call_sids"].discard(request.sid)
        room["mic_muted"].pop(request.sid, None)

    socketio.emit("call_peer_left", {"sid": request.sid}, to=rid)
    socketio.emit("call_count", {"count": len(rooms[rid]["call_sids"])}, to=rid)
    emit_call_audio_state(rid)


@socketio.on("webrtc_offer")
def on_webrtc_offer(data):
    rid = require_room(data)
    if not rid:
        return
    target = str(data.get("target", ""))
    if not target:
        return
    emit(
        "webrtc_offer",
        {"from": request.sid, "offer": data.get("offer")},
        to=target,
    )


@socketio.on("webrtc_answer")
def on_webrtc_answer(data):
    rid = require_room(data)
    if not rid:
        return
    target = str(data.get("target", ""))
    if not target:
        return
    emit(
        "webrtc_answer",
        {"from": request.sid, "answer": data.get("answer")},
        to=target,
    )


@socketio.on("webrtc_ice")
def on_webrtc_ice(data):
    rid = require_room(data)
    if not rid:
        return
    target = str(data.get("target", ""))
    if not target:
        return
    emit(
        "webrtc_ice",
        {"from": request.sid, "candidate": data.get("candidate")},
        to=target,
    )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Watch Together running on http://127.0.0.1:{port}")
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)
