const socket = io();
const $ = id => document.getElementById(id);
let roomId = new URLSearchParams(location.search).get("room")?.toUpperCase() || null;
let upload = {file:null,id:null,paused:false,cancelled:false,received:0,started:0,lastBytes:0,lastTime:0,recent:[],ranges:[]};
let syncing = false;

// WebRTC call state
let peer = null;
let peerSid = null;
let localStream = null;
let micMuted = true;
let cameraEnabled = true;
let callJoined = false;
let callAutoPaused = false;
const rtcConfig = {
  iceServers: [{urls: "stun:stun.l.google.com:19302"}]
};

function toast(msg){
  $("toast").textContent=msg;
  $("toast").style.display="block";
  clearTimeout(window.__toastTimer);
  window.__toastTimer=setTimeout(()=>$("toast").style.display="none",2200);
}
function fmtBytes(n){
  if(!n)return"0 B";
  const u=["B","KB","MB","GB"];let i=0;
  while(n>=1024&&i<3){n/=1024;i++}
  return `${n.toFixed(i?2:0)} ${u[i]}`;
}
function fmtTime(sec){
  if(!isFinite(sec)||sec<0)return"—";
  sec=Math.round(sec);
  if(sec<60)return`${sec}s`;
  let m=Math.floor(sec/60),s=sec%60;
  if(m<60)return`${m}m ${s}s`;
  return`${Math.floor(m/60)}h ${m%60}m`;
}
function esc(s){
  return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

socket.on("connect",()=>{
  $("connection").textContent="● Connected";
  if(roomId) enterRoom(roomId);
});
socket.on("disconnect",()=>{
  $("connection").textContent="Offline";
  setCallStatus("Server disconnected");
});
socket.on("error_message",d=>toast(d.message));

$("createBtn").onclick=async()=>{
  const r=await fetch("/api/create-room",{method:"POST"});
  const d=await r.json();
  enterRoom(d.room_id);
};
$("joinBtn").onclick=()=>enterRoom($("joinInput").value.trim().toUpperCase());
$("copyBtn").onclick=async()=>{
  await navigator.clipboard.writeText(location.origin+"/?room="+roomId);
  toast("Invite link copied");
};
$("readyBtn").onclick=()=>{
  $("readyStatus").textContent="You are ready ✓";
  $("readyBtn").textContent="✓ Ready";
};

async function enterRoom(rid){
  if(!rid)return;
  const r=await fetch("/api/room/"+encodeURIComponent(rid));
  if(!r.ok){toast("Room not found or expired");return}
  roomId=rid;
  history.replaceState({}, "", "?room="+encodeURIComponent(roomId));
  $("home").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("roomId").textContent=roomId;
  socket.emit("join",{room_id:roomId});
}

socket.on("viewer_count",d=>$("viewerCount").textContent=`${d.count} watching`);
socket.on("call_count",d=>$("callCount").textContent=`Call: ${d.count}/2`);

socket.on("room_state",d=>{
  if(d.filename) setVideo(d.filename,d.position,d.playing);
});
socket.on("video_ready",d=>{
  setVideo(d.filename,0,false);
  toast("Video is ready for both viewers");
});

function setVideo(filename,pos,playing){
  const v=$("video");
  v.src="/media/"+encodeURIComponent(filename);
  v.classList.remove("hidden");
  $("emptyVideo").classList.add("hidden");
  $("pipBtn").classList.remove("hidden");
  v.onloadedmetadata=()=>{
    if(isFinite(pos))v.currentTime=Math.min(pos||0,v.duration||0);
    if(playing && !callAutoPaused)v.play().catch(()=>{});
  };
}

$("video").addEventListener("play",()=>{
  if(syncing || callAutoPaused)return;
  socket.emit("play",{room_id:roomId,position:$("video").currentTime});
});
$("video").addEventListener("pause",()=>{
  if(syncing)return;
  socket.emit("pause",{room_id:roomId,position:$("video").currentTime});
});
$("video").addEventListener("seeking",()=>{
  if(syncing)return;
  socket.emit("seek",{room_id:roomId,position:$("video").currentTime});
});
$("video").addEventListener("timeupdate",()=>{
  if(!syncing)socket.emit("time_update",{room_id:roomId,position:$("video").currentTime});
});
$("video").addEventListener("loadedmetadata",()=>{
  socket.emit("duration",{room_id:roomId,duration:$("video").duration});
});

$("pipBtn").onclick=async()=>{
  const v=$("video");
  try{
    if(document.pictureInPictureElement) await document.exitPictureInPicture();
    else if(v.requestPictureInPicture) await v.requestPictureInPicture();
    else toast("Mini player is not supported by this browser");
  }catch(e){toast("Could not open mini player")}
};

async function syncSet(fn){
  syncing=true;
  try{await fn()}finally{setTimeout(()=>syncing=false,120)}
}
socket.on("sync_play",d=>syncSet(async()=>{
  if(callAutoPaused)return;
  $("video").currentTime=d.position;
  await $("video").play().catch(()=>{});
}));
socket.on("sync_pause",d=>syncSet(async()=>{
  $("video").currentTime=d.position;
  $("video").pause();
}));
socket.on("sync_seek",d=>syncSet(async()=>{
  $("video").currentTime=d.position;
}));

$("fileInput").onchange=()=>{
  const f=$("fileInput").files[0];
  if(!f)return;
  if(f.size>3*1024**3){
    toast("File is larger than 3 GiB");
    $("fileInput").value="";
    return;
  }
  upload.file=f;
  $("fileMeta").textContent=`${f.name} • ${fmtBytes(f.size)}`;
};

function mergeRanges(ranges){
  ranges.sort((a,b)=>a.start-b.start);
  const out=[];
  for(const r of ranges){
    const last=out[out.length-1];
    if(last&&r.start<=last.end+1)last.end=Math.max(last.end,r.end);
    else out.push({...r});
  }
  return out;
}
function covered(ranges){
  let n=0;
  for(const r of ranges)n+=r.end-r.start+1;
  return n;
}
function nextOffset(ranges,total){
  let p=0;
  for(const r of ranges){
    if(r.start>p)break;
    if(r.end>=p)p=r.end+1;
  }
  return Math.min(p,total);
}
function chooseChunk(speed){
  if(speed>80*1024*1024)return 250*1024*1024;
  if(speed>30*1024*1024)return 100*1024*1024;
  if(speed<4*1024*1024)return 25*1024*1024;
  return 50*1024*1024;
}
async function getUploadStatus(id){
  const r=await fetch(`/api/upload/${id}/status`);
  if(!r.ok)throw Error("Upload session expired");
  return r.json();
}
function updateUploadUI(received,total,speed,avg,chunk){
  const pct=total?received/total*100:0;
  $("progressBar").style.width=pct.toFixed(2)+"%";
  $("progressPct").textContent=pct.toFixed(1)+"%";
  $("uploadedText").textContent=`${fmtBytes(received)} / ${fmtBytes(total)}`;
  $("speed").textContent=speed?fmtBytes(speed)+"/s":"—";
  $("avgSpeed").textContent=avg?fmtBytes(avg)+"/s":"—";
  $("eta").textContent=avg?fmtTime((total-received)/avg):"—";
  $("chunkSize").textContent=fmtBytes(chunk);
}

async function uploadFile(){
  if(!upload.file){toast("Choose a video first");return}
  const f=upload.file;
  upload.paused=false;
  upload.cancelled=false;
  $("startUpload").disabled=true;
  $("pauseUpload").disabled=false;
  $("cancelUpload").disabled=false;
  $("uploadStatus").textContent="Starting…";
  try{
    if(!upload.id){
      const r=await fetch("/api/upload/start",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({room_id:roomId,filename:f.name,size:f.size,mime:f.type||"video/mp4"})
      });
      const d=await r.json();
      if(!r.ok)throw Error(d.error||"Could not start upload");
      upload.id=d.upload_id;
      localStorage.setItem("wt_upload",JSON.stringify({id:upload.id,roomId,name:f.name,size:f.size}));
    }
    const st=await getUploadStatus(upload.id);
    upload.ranges=st.ranges||[];
    upload.received=covered(upload.ranges);
    if(upload.started===0)upload.started=performance.now();

    let last=performance.now(),lastBytes=upload.received,speed=0;
    while(upload.received<f.size){
      if(upload.paused)break;
      const offset=nextOffset(upload.ranges,f.size);
      const chunk=chooseChunk(speed||5*1024*1024);
      const end=Math.min(f.size,offset+chunk)-1;
      if(end<offset)break;
      const blob=f.slice(offset,end+1);
      let ok=false,attempt=0;

      while(!ok&&attempt<4&&!upload.paused&&!upload.cancelled){
        attempt++;
        try{
          const ctrl=new AbortController();
          upload.ctrl=ctrl;
          const r=await fetch(`/api/upload/${upload.id}/chunk`,{
            method:"PUT",
            headers:{
              "Content-Type":"application/octet-stream",
              "X-Chunk-Start":String(offset),
              "X-Chunk-End":String(end),
              "X-Upload-Total":String(f.size)
            },
            body:blob,
            signal:ctrl.signal
          });
          const d=await r.json();
          if(!r.ok)throw Error(d.error||"Chunk failed");
          ok=true;
        }catch(e){
          if(upload.cancelled||upload.paused)break;
          if(attempt<4){
            $("uploadStatus").textContent=`Retrying chunk (${attempt}/3)…`;
            await new Promise(r=>setTimeout(r,700*2**(attempt-1)));
          }else throw e;
        }
      }

      if(!ok)break;
      upload.ranges=mergeRanges([...upload.ranges,{start:offset,end}]);
      upload.received=covered(upload.ranges);

      const now=performance.now(),dt=(now-last)/1000,db=upload.received-lastBytes;
      if(dt>0){
        speed=db/dt;
        upload.recent.push({t:now,b:upload.received});
        upload.recent=upload.recent.filter(x=>now-x.t<10000);
      }
      const recent=upload.recent;
      let rs=0;
      if(recent.length>1){
        const a=recent[0],b=recent[recent.length-1];
        rs=(b.b-a.b)/((b.t-a.t)/1000);
      }
      const avg=upload.received/((now-upload.started)/1000);
      updateUploadUI(upload.received,f.size,rs||speed,avg,chunk);
      last=now;
      lastBytes=upload.received;
      $("uploadStatus").textContent=upload.received>=f.size?"Finalising…":`Uploading • smart chunk ${fmtBytes(chunk)}`;
    }

    if(upload.cancelled)return;
    if(upload.paused){
      $("uploadStatus").textContent="Paused — your progress is saved.";
      return;
    }

    const r=await fetch(`/api/upload/${upload.id}/complete`,{method:"POST"});
    const d=await r.json();
    if(!r.ok)throw Error(d.error||"Could not complete");

    localStorage.removeItem("wt_upload");
    upload.id=null;
    $("uploadStatus").textContent="Upload complete ✓";
    $("pauseUpload").disabled=true;
    $("cancelUpload").disabled=true;
  }catch(e){
    $("uploadStatus").textContent=e.message||"Upload failed";
    toast(e.message||"Upload failed");
    $("startUpload").disabled=false;
  }
}
$("startUpload").onclick=uploadFile;
$("pauseUpload").onclick=()=>{
  upload.paused=true;
  upload.ctrl?.abort();
  $("startUpload").disabled=false;
  $("pauseUpload").disabled=true;
};
$("cancelUpload").onclick=async()=>{
  upload.cancelled=true;
  upload.ctrl?.abort();
  if(upload.id)await fetch(`/api/upload/${upload.id}`,{method:"DELETE"});
  upload={file:upload.file,id:null,paused:false,cancelled:false,received:0,started:0,lastBytes:0,lastTime:0,recent:[],ranges:[]};
  localStorage.removeItem("wt_upload");
  $("startUpload").disabled=false;
  $("pauseUpload").disabled=true;
  $("cancelUpload").disabled=true;
  $("uploadStatus").textContent="Cancelled";
};

$("sendBtn").onclick=sendChat;
$("chatInput").onkeydown=e=>{if(e.key==="Enter")sendChat()};
function sendChat(){
  const m=$("chatInput").value.trim();
  if(!m)return;
  socket.emit("chat",{room_id:roomId,message:m,name:$("nameInput").value.trim()||"Guest"});
  $("chatInput").value="";
}
socket.on("chat_message",d=>{
  const el=document.createElement("div");
  el.className="msg";
  el.innerHTML=`<b>${esc(d.name)}</b><span>${esc(d.time)}</span><div>${esc(d.message)}</div>`;
  $("messages").appendChild(el);
  $("messages").scrollTop=$("messages").scrollHeight;
});
document.querySelectorAll("[data-emoji]").forEach(b=>b.onclick=()=>{
  socket.emit("reaction",{room_id:roomId,emoji:b.dataset.emoji});
});
socket.on("reaction",d=>{
  const x=document.createElement("div");
  x.className="reaction-float";
  x.textContent=d.emoji;
  document.body.appendChild(x);
  setTimeout(()=>x.remove(),1000);
});

// ---------- WebRTC video + voice call ----------

function setCallStatus(text){
  $("callStatus").textContent=text;
}
function setCallButtons(joined){
  $("joinCallBtn").disabled=joined;
  $("muteBtn").disabled=!joined;
  $("cameraBtn").disabled=!joined;
  $("leaveCallBtn").disabled=!joined;
}
function updateMuteUI(){
  $("muteBtn").textContent=micMuted?"🎙️ Unmute":"🔇 Mute";
  $("callNotice").textContent=micMuted
    ?"Mic muted — movie can play. Unmute when you want to talk."
    :"Mic ON — movie is paused so you can talk.";
}
function updateCameraUI(){
  $("cameraBtn").textContent=cameraEnabled?"📷 Camera off":"📷 Camera on";
}

async function createPeer(targetSid, initiator){
  if(peer) peer.close();
  peerSid=targetSid;

  peer=new RTCPeerConnection(rtcConfig);

  peer.onicecandidate=e=>{
    if(e.candidate){
      socket.emit("webrtc_ice",{room_id:roomId,target:peerSid,candidate:e.candidate});
    }
  };

  peer.ontrack=e=>{
    const stream=e.streams[0];
    if(stream)$("remoteVideo").srcObject=stream;
    setCallStatus("Connected • video + voice");
  };

  peer.onconnectionstatechange=()=>{
    if(!peer)return;
    if(["failed","disconnected","closed"].includes(peer.connectionState)){
      setCallStatus("Call disconnected");
    }
  };

  if(localStream){
    localStream.getTracks().forEach(track=>peer.addTrack(track,localStream));
  }

  if(initiator){
    const offer=await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.emit("webrtc_offer",{room_id:roomId,target:peerSid,offer:peer.localDescription});
  }
}

socket.on("call_peer",async d=>{
  if(!callJoined)return;
  try{
    await createPeer(d.sid,d.initiator);
    if(d.initiator)setCallStatus("Calling…");
    else setCallStatus("Connecting…");
  }catch(e){
    console.error(e);
    toast("Could not start peer connection");
  }
});

socket.on("webrtc_offer",async d=>{
  if(!callJoined)return;
  try{
    if(!peer || peerSid!==d.from)await createPeer(d.from,false);
    await peer.setRemoteDescription(new RTCSessionDescription(d.offer));
    const answer=await peer.createAnswer();
    await peer.setLocalDescription(answer);
    socket.emit("webrtc_answer",{room_id:roomId,target:d.from,answer:peer.localDescription});
  }catch(e){
    console.error(e);
    toast("Could not answer the call");
  }
});

socket.on("webrtc_answer",async d=>{
  if(!peer)return;
  try{
    await peer.setRemoteDescription(new RTCSessionDescription(d.answer));
  }catch(e){console.error(e)}
});

socket.on("webrtc_ice",async d=>{
  if(!peer)return;
  try{
    await peer.addIceCandidate(new RTCIceCandidate(d.candidate));
  }catch(e){console.error(e)}
});

socket.on("call_peer_left",d=>{
  if(peerSid===d.sid){
    peer?.close();
    peer=null;
    peerSid=null;
    $("remoteVideo").srcObject=null;
    setCallStatus("Partner left the call");
    toast("Partner left the call");
  }
});

$("joinCallBtn").onclick=async()=>{
  if(callJoined)return;
  if(!navigator.mediaDevices?.getUserMedia){
    toast("Camera/microphone access requires HTTPS or localhost");
    return;
  }
  try{
    localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    $("localVideo").srcObject=localStream;
    callJoined=true;
    micMuted=true;
    cameraEnabled=true;
    setCallButtons(true);
    updateMuteUI();
    updateCameraUI();
    setCallStatus("Waiting for partner…");
    socket.emit("call_join",{room_id:roomId});
  }catch(e){
    toast("Camera/microphone permission was denied or unavailable");
  }
};

$("muteBtn").onclick=()=>{
  if(!localStream)return;
  micMuted=!micMuted;
  const track=localStream.getAudioTracks()[0];
  if(track)track.enabled=!micMuted;
  updateMuteUI();
  socket.emit("call_mute",{room_id:roomId,muted:micMuted});
};

$("cameraBtn").onclick=()=>{
  if(!localStream)return;
  cameraEnabled=!cameraEnabled;
  const track=localStream.getVideoTracks()[0];
  if(track)track.enabled=cameraEnabled;
  updateCameraUI();
};

$("leaveCallBtn").onclick=leaveCall;

function leaveCall(){
  if(roomId)socket.emit("call_leave",{room_id:roomId});
  peer?.close();
  peer=null;
  peerSid=null;
  localStream?.getTracks().forEach(t=>t.stop());
  localStream=null;
  $("localVideo").srcObject=null;
  $("remoteVideo").srcObject=null;
  callJoined=false;
  micMuted=true;
  cameraEnabled=true;
  callAutoPaused=false;
  setCallButtons(false);
  setCallStatus("Not connected");
  updateMuteUI();
  updateCameraUI();
  const v=$("video");
  if(v && !v.paused && !v.ended) return;
}

socket.on("call_audio_state",async d=>{
  if(!callJoined)return;

  // User-requested behavior:
  // if anyone in the active call unmutes, pause the movie for both.
  // when every active caller is muted, resume the movie.
  const anyUnmuted=!!d.any_unmuted;
  const v=$("video");
  if(!v || v.classList.contains("hidden"))return;

  if(anyUnmuted){
    callAutoPaused=true;
    if(!v.paused)v.pause();
    $("movieModeText").textContent="Voice chat mode • movie paused";
    $("movieMode").classList.add("talking");
  }else{
    const shouldResume=callAutoPaused;
    callAutoPaused=false;
    $("movieModeText").textContent="Movie mode • voice muted";
    $("movieMode").classList.remove("talking");
    if(shouldResume && v.paused){
      await v.play().catch(()=>toast("Press Play once to allow video playback"));
    }
  }
});

// Attempt to restore a paused upload session when the user returns.
const saved=localStorage.getItem("wt_upload");
if(saved){
  try{
    const s=JSON.parse(saved);
    $("uploadStatus").textContent=`Resumable upload found for ${s.name}. Choose the same file and press Start upload.`;
    if(!roomId&&s.roomId)roomId=s.roomId;
  }catch{}
}
