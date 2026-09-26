# Watch Together V3

Upgraded from V2 with:

- Better 16:9 movie player that preserves the video's aspect ratio
- Browser Picture-in-Picture mini player
- 1-to-1 WebRTC video call
- Voice chat through the call
- Microphone mute/unmute
- Camera on/off
- Leave call
- Call connection status
- Two-person call limit
- Automatic movie behavior:
  - microphone muted -> movie can play
  - anyone in the active call unmutes -> movie pauses for both
  - all active callers mute again -> movie resumes
- Existing resumable 3 GiB upload, smart chunks, retry, chat, reactions and synchronized playback

## Run

```powershell
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000

## WebRTC note

Camera/microphone access works on localhost and HTTPS. Public deployment should use HTTPS.

The call uses browser-to-browser WebRTC with a public STUN server. Some restrictive networks may require a TURN server for reliable connections in production.
