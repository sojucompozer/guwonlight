(function initPromoGestureSite() {
  const GESTURE_TO_TRACK = {
    Paper: "vocal",
    Fist: "drum",
    Index: "bass",
    Peace: "synth",
    Three: "guitar"
  };

  const state = {
    xy: { x: 0.66, y: 0.34 },
    lastGesture: "NONE",
    candidateGesture: "NONE",
    stableGestureCount: 0,
    transportStarted: false,
    reverb: null,
    filter: null,
    players: {},
    trackState: {
      vocal: { active: false, waiting: false, pendingEventId: null },
      drum: { active: false, waiting: false, pendingEventId: null },
      bass: { active: false, waiting: false, pendingEventId: null },
      synth: { active: false, waiting: false, pendingEventId: null },
      guitar: { active: false, waiting: false, pendingEventId: null }
    }
  };

  const trackRows = Array.from(document.querySelectorAll(".track-row"));
  const trackRowsByName = Object.fromEntries(trackRows.map((row) => [row.dataset.track, row]));
  const xyNode = document.querySelector(".xy-node");
  const xyPad = document.querySelector(".xy-pad");
  const webcamFrame = document.querySelector(".webcam-frame");
  const videoEl = document.querySelector(".webcam-video");
  const canvasEl = document.querySelector(".webcam-canvas");
  const gestureValueEl = document.querySelector(".gesture-value");
  const enterOverlay = document.querySelector("#enterOverlay");
  const enterButton = document.querySelector("#enterButton");

  if (!xyPad || !xyNode || !videoEl || !canvasEl || !webcamFrame) return;

  const canvasCtx = canvasEl.getContext("2d");

  function setXYNode(x, y) {
    const safeX = Math.min(Math.max(x, 0), 1);
    const safeY = Math.min(Math.max(y, 0), 1);
    state.xy = { x: safeX, y: safeY };
    xyNode.style.setProperty("--x", `${(safeX * 100).toFixed(2)}%`);
    xyNode.style.setProperty("--y", `${(safeY * 100).toFixed(2)}%`);
  }

  function syncCanvasSize() {
    const width = videoEl.videoWidth || videoEl.clientWidth;
    const height = videoEl.videoHeight || videoEl.clientHeight;
    if (!width || !height) return;
    canvasEl.width = width;
    canvasEl.height = height;
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function updateGestureReadout(gesture) {
    if (!gestureValueEl) return;
    gestureValueEl.textContent = gesture || "NONE";
  }

  function applyTrackUiState(track) {
    const row = trackRowsByName[track];
    const config = state.trackState[track];
    if (!row || !config) return;
    row.classList.toggle("is-waiting", config.waiting);
    row.classList.toggle("is-active", config.active);
  }

  function setTrackActive(track, shouldBeActive) {
    const config = state.trackState[track];
    const player = state.players[track];
    if (!config || !player) return;
    config.active = shouldBeActive;
    player.mute = !shouldBeActive;
    applyTrackUiState(track);
  }

  function scheduleTrackToggle(track) {
    if (!state.transportStarted || !state.players[track]) return;
    const config = state.trackState[track];
    if (!config || config.waiting) return;

    config.waiting = true;
    applyTrackUiState(track);

    const eventId = Tone.Transport.scheduleOnce((time) => {
      config.waiting = false;
      config.pendingEventId = null;
      const nextActive = !config.active;
      setTrackActive(track, nextActive);
      applyTrackUiState(track);
    }, "@1m");

    config.pendingEventId = eventId;
  }

  function mapLeftHandToFx(x, y) {
    if (!state.reverb || !state.filter) return;
    const safeX = Math.min(Math.max(x, 0), 1);
    const safeY = Math.min(Math.max(y, 0), 1);
    state.reverb.wet.value = safeX;
    const minHz = 160;
    const maxHz = 9000;
    const hz = minHz + (1 - safeY) * (maxHz - minHz);
    state.filter.frequency.rampTo(hz, 0.05);
  }

  function mapHandXToPadX(x) {
    return 1 - x;
  }

  function getFingerStatesByDistance(landmarks) {
    const wrist = landmarks[0];
    const palmRef = distance(landmarks[0], landmarks[9]) || 0.12;
    const fingerDefs = [
      { name: "thumb", tip: 4, pip: 3, mcp: 2 },
      { name: "index", tip: 8, pip: 6, mcp: 5 },
      { name: "middle", tip: 12, pip: 10, mcp: 9 },
      { name: "ring", tip: 16, pip: 14, mcp: 13 },
      { name: "pinky", tip: 20, pip: 18, mcp: 17 }
    ];

    const states = {};
    fingerDefs.forEach(({ name, tip, pip, mcp }) => {
      const tipDist = distance(landmarks[tip], wrist);
      const pipDist = distance(landmarks[pip], wrist);
      const mcpDist = distance(landmarks[mcp], wrist);
      const foldRatio = tipDist / (pipDist || 0.001);
      const palmRatio = tipDist / palmRef;
      const yCurl = landmarks[tip].y > landmarks[mcp].y - 0.01;
      const tipCloserThanMcp = tipDist < mcpDist * 1.1;

      states[name] = {
        extended: foldRatio > 1.16 && palmRatio > (name === "thumb" ? 1.15 : 1.28),
        curled:
          (foldRatio < 1.1 && palmRatio < (name === "thumb" ? 1.35 : 1.32)) ||
          (tipCloserThanMcp && yCurl),
        tipCloserThanMcp,
        yCurl,
        tipDist,
        pipDist
      };
    });

    return states;
  }

  function classifyGesture(landmarks) {
    const finger = getFingerStatesByDistance(landmarks);
    const fistFoldedCount = ["index", "middle", "ring", "pinky"].filter((name) => {
      const f = finger[name];
      return f.tipDist < f.pipDist * 1.2;
    }).length;
    const allCurled = fistFoldedCount === 4;
    const allExtended = Object.values(finger).every((f) => f.extended);

    if (allCurled) return "Fist";
    if (allExtended) return "Paper";
    if (finger.index.extended && finger.middle.curled && finger.ring.curled && finger.pinky.curled) return "Index";
    if (finger.index.extended && finger.middle.extended && finger.ring.curled && finger.pinky.curled) return "Peace";
    if (finger.index.extended && finger.middle.extended && finger.ring.extended && finger.pinky.curled) return "Three";
    return "NONE";
  }

  function emitStableGesture(nextGesture) {
    if (nextGesture === state.candidateGesture) {
      state.stableGestureCount += 1;
    } else {
      state.candidateGesture = nextGesture;
      state.stableGestureCount = 1;
    }

    if (state.stableGestureCount >= 3 && state.lastGesture !== nextGesture) {
      state.lastGesture = nextGesture;
      updateGestureReadout(nextGesture);
      console.log(`RIGHT HAND GESTURE: ${nextGesture}`);

      const mappedTrack = GESTURE_TO_TRACK[nextGesture];
      if (mappedTrack) {
        scheduleTrackToggle(mappedTrack);
      }
    }
  }

  function onResults(results) {
    syncCanvasSize();
    canvasCtx.save();
    canvasCtx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    const landmarksList = results.multiHandLandmarks || [];
    const handednessList = results.multiHandedness || [];
    let sawRightHand = false;

    for (let i = 0; i < landmarksList.length; i += 1) {
      const landmarks = landmarksList[i];
      const handedness = handednessList[i]?.label || "Unknown";

      drawConnectors(canvasCtx, landmarks, HAND_CONNECTIONS, {
        color: "rgba(236, 244, 255, 0.7)",
        lineWidth: 1
      });
      drawLandmarks(canvasCtx, landmarks, {
        color: "rgba(236, 244, 255, 0.95)",
        fillColor: "rgba(236, 244, 255, 0.95)",
        lineWidth: 0.8,
        radius: 1.2
      });

      if (handedness === "Right") {
        sawRightHand = true;
        const gesture = classifyGesture(landmarks);
        emitStableGesture(gesture);
      } else if (handedness === "Left") {
        const indexTip = landmarks[8];
        if (indexTip) {
          const mappedX = mapHandXToPadX(indexTip.x);
          setXYNode(mappedX, indexTip.y);
          mapLeftHandToFx(mappedX, indexTip.y);
        }
      }
    }

    if (!sawRightHand) {
      emitStableGesture("NONE");
    }

    canvasCtx.restore();
  }

  async function setupMediaPipeHands() {
    if (typeof Hands === "undefined" || typeof Camera === "undefined") {
      console.error("MediaPipe CDN scripts failed to load.");
      return;
    }

    const hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      selfieMode: true,
      minDetectionConfidence: 0.65,
      minTrackingConfidence: 0.65
    });
    hands.onResults(onResults);

    const camera = new Camera(videoEl, {
      onFrame: async () => {
        await hands.send({ image: videoEl });
      },
      width: 640,
      height: 360
    });

    await camera.start();
    webcamFrame.classList.add("is-live");
    syncCanvasSize();
  }

  async function setupTone() {
    if (typeof Tone === "undefined") {
      console.error("Tone.js CDN failed to load.");
      return;
    }

    Tone.Transport.bpm.value = 174;

    const reverb = new Tone.Reverb({
      decay: 12,
      wet: 0.2
    });
    const filter = new Tone.Filter({
      frequency: 3800,
      type: "lowpass",
      rolloff: -24
    });

    reverb.connect(filter);
    filter.toDestination();

    const trackAudioPath = {
      vocal: "./audio/vocal.wav",
      drum: "./audio/drum.wav",
      bass: "./audio/bass.wav",
      synth: "./audio/synth.wav",
      guitar: "./audio/guitar.wav"
    };
    const tracks = Object.keys(trackAudioPath);
    for (const track of tracks) {
      const player = new Tone.Player({
        url: trackAudioPath[track],
        loop: true,
        autostart: false
      });
      player.connect(reverb);
      player.mute = true;
      state.players[track] = player;
    }

    state.reverb = reverb;
    state.filter = filter;

    await Tone.loaded();
    tracks.forEach((track) => {
      state.players[track].sync().start(0);
      applyTrackUiState(track);
    });
  }

  async function startAudioEngine() {
    if (state.transportStarted) return;
    try {
      await Tone.start();
      if (Tone.Transport.state !== "started") {
        Tone.Transport.start();
      }
      state.transportStarted = true;
      if (enterOverlay) {
        enterOverlay.classList.add("is-hidden");
        window.setTimeout(() => {
          enterOverlay.style.display = "none";
        }, 340);
      }
      console.log("Audio engine started.");
    } catch (error) {
      console.error("Failed to start audio engine:", error);
    }
  }

  trackRows.forEach((row) => {
    row.addEventListener("mouseenter", () => {
      const active = row.querySelector(".clip-slot.active");
      if (active) active.style.filter = "brightness(1.28)";
    });
    row.addEventListener("mouseleave", () => {
      const active = row.querySelector(".clip-slot.active");
      if (active) active.style.filter = "";
    });
  });

  xyPad.addEventListener("pointermove", (event) => {
    if (event.buttons !== 1) return;
    const rect = xyPad.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    setXYNode(x, y);
    mapLeftHandToFx(x, y);
  });

  window.addEventListener("resize", syncCanvasSize);
  if (enterButton) {
    enterButton.addEventListener("click", startAudioEngine);
  }
  updateGestureReadout("NONE");
  window.promoState = state;
  setupTone().catch((error) => {
    console.error("Failed to initialize Tone.js:", error);
  });
  setupMediaPipeHands().catch((error) => {
    console.error("Failed to initialize webcam/MediaPipe:", error);
  });
})();
