// receiving.js
const { debugLog, pcmToWavBlob, concatFloat32, createAudioContext } = SoundComm;

(function () {
  // 画面にデバッグログを出力するタイミングを最初に追加
  debugLog("receiving.js initialized");

  const startBtn = document.getElementById("start");
  const stopBtn = document.getElementById("stop");
  const decodeBtn = document.getElementById("decode");
  const statusEl = document.getElementById("status");
  const resultEl = document.getElementById("result");
  const hiraEl = document.getElementById("decodedHira");
  const logEl = document.getElementById("log");
  const useHammingRxEl = document.getElementById("useHammingRx");
  const recPlayer = document.getElementById("recPlayer");

  const brEl = document.getElementById("br");
  const f0El = document.getElementById("f0");
  const f1El = document.getElementById("f1");
  const secsEl = document.getElementById("secs");
  const bitsExpectedEl = document.getElementById("bitsExpected");
  const usePreambleEl = document.getElementById("usePreamble");
  const preSecEl = document.getElementById("preSec");
  const thEl = document.getElementById("th");

  let ctx, mediaStream, source, processor;
  let captured = [];
  let sampleRate = 44100;
  let recUrl = null;
  let stopTimer = null;

  function setStatus(msg, cls = "") {
    statusEl.className = cls || "hint";
    statusEl.textContent = msg;
  }

  // 音声の正規化
  function normalizeFloat32(arr) {
    let sum = 0;
    for (const v of arr) sum += v * v;
    const rms = Math.sqrt(sum / arr.length) || 1;
    const g = 0.5 / rms;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++)
      out[i] = Math.max(-1, Math.min(1, arr[i] * g));
    return out;
  }

  // 録音開始処理
  async function startRecording() {
    try {
      debugLog("startRecording: 録音開始");

      // 既存の録音があれば停止してから再開する
      if (processor || source || mediaStream) {
        stopRecording();
      }

      captured = [];

      if (!ctx) {
        ctx = createAudioContext(44100);
      }

      await ctx.resume();

      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        video: false
      });

      sampleRate = ctx.sampleRate;
      debugLog("startRecording: MediaStream 確保 OK, sampleRate=" + sampleRate);

      source = ctx.createMediaStreamSource(mediaStream);

      const bufferSize = 2048;
      processor = ctx.createScriptProcessor(bufferSize, 1, 1);
      processor.onaudioprocess = (e) => {
        captured.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      const secs = Math.max(1, Math.min(20, Number(secsEl.value) || 4));
      setStatus(`録音中…（${secs}秒）`, "ok");
      startBtn.disabled = true;
      stopBtn.disabled = false;
      decodeBtn.disabled = true;

      if (stopTimer) {
        clearTimeout(stopTimer);
        stopTimer = null;
      }
      stopTimer = setTimeout(() => {
        stopTimer = null;
        stopRecording();
      }, secs * 1000);
    } catch (err) {
      debugLog("startRecording: エラー", err);
      console.error(err);

      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }

      if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
      }

      if (source) {
        source.disconnect();
        source = null;
      }

      startBtn.disabled = false;
      stopBtn.disabled = true;
      decodeBtn.disabled = captured.length === 0;

      setStatus(
        "マイク取得に失敗しました。HTTPSと権限を確認してください。",
        "err"
      );
    }
  }

  // 録音停止処理
  function stopRecording() {
    debugLog("stopRecording: 呼び出し, チャンク数=" + captured.length);
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (source) {
      source.disconnect();
      source = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = null;
    }

    // 録音した音を再生できるようにする
    if (captured.length && recPlayer) {
      const pcm = concatFloat32(captured); // 全チャンクを1本に
      const blob = pcmToWavBlob(pcm, sampleRate); // WAVに変換
      if (recUrl) {
        URL.revokeObjectURL(recUrl);
      }
      recUrl = URL.createObjectURL(blob);
      recPlayer.pause();
      recPlayer.src = recUrl;
      recPlayer.load();
      recPlayer.currentTime = 0;
      debugLog("stopRecording: WAV を recPlayer にセット");
    } else {
      debugLog("stopRecording: captured が空, 再生用データなし");
    }

    startBtn.disabled = false;
    stopBtn.disabled = true;
    decodeBtn.disabled = false;
    setStatus("録音完了。解析できます。", "ok");
  }

  // 解析処理（復調）
  function decodeNow() {
    debugLog("decodeNow: 解析開始, captured チャンク数=" + captured.length);
    if (!captured.length) {
      setStatus("録音データがありません。", "err");
      return;
    }

    const fs = sampleRate;
    const br = Number(brEl.value) || 30;
    const f0 = Number(f0El.value) || 1400;
    const f1 = Number(f1El.value) || 2200;
    const bitsExpected = Number(bitsExpectedEl.value) || null;
    const usePre = usePreambleEl.checked;
    const preSec = Number(preSecEl.value) || 0;
    const th = Number(thEl.value) || 1.4;

    const raw = concatFloat32(captured);

    setStatus("解析中…", "hint");
    const t0 = performance.now();
    const out = demodFSK(
      raw,
      fs,
      br,
      f0,
      f1,
      bitsExpected,
      usePre,
      th,
      preSec
    );
    const t1 = performance.now();

    const rawBits = out.bits || "";
    let dataBits = rawBits;

    // Hammingを使う場合はここで復号（14bit→8bit）
    if (useHammingRxEl.checked) {
      dataBits = HammingCodec.decode(rawBits);
    }

    resultEl.textContent = dataBits || "(空)";

    // ひらがなデコード
    hiraEl.textContent =
      window.KanaCodec.bitsToHiragana(dataBits || "") || "(デコード結果なし)";

    setStatus(
      `解析完了（${(t1 - t0).toFixed(1)} ms, 生=${rawBits.length}bit / データ=${dataBits.length}bit）`,
      "ok"
    );
    debugLog(
      `decodeNow: 完了 rawBits=${rawBits.length}, dataBits=${dataBits.length}, elapsed=${(
        t1 - t0
      ).toFixed(1)}ms`
    );
  }

  startBtn.addEventListener("click", startRecording);
  stopBtn.addEventListener("click", stopRecording);
  decodeBtn.addEventListener("click", decodeNow);
})();
