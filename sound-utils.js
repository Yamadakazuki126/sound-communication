// sound-utils.js
(function (global) {
  function debugLog(msg) {
    console.log(msg);  // コンソールにも出力
    const box = document.getElementById("debug-log");
    if (!box) {
      console.warn("debug-log element not found!");
      return;
    }
    const time = new Date().toISOString().split("T")[1].split(".")[0];
    box.textContent += `[${time}] ${msg}\n`;  // ログを追加
    box.scrollTop = box.scrollHeight;  // スクロールを下に
  }

  function pcmToWavBlob(pcm, sampleRate) {
    const numFrames = pcm.length;
    const numChannels = 1;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numFrames * bytesPerSample;

    const buf = new ArrayBuffer(44 + dataSize);
    const dv = new DataView(buf);

    writeStr(dv, 0, "RIFF");
    dv.setUint32(4, 36 + dataSize, true);
    writeStr(dv, 8, "WAVE");

    writeStr(dv, 12, "fmt ");
    dv.setUint32(16, 16, true); // PCM
    dv.setUint16(20, 1, true);  // PCM
    dv.setUint16(22, numChannels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, byteRate, true);
    dv.setUint16(32, blockAlign, true);
    dv.setUint16(34, 16, true); // 16bit

    writeStr(dv, 36, "data");
    dv.setUint32(40, dataSize, true);

    let o = 44;
    for (let i = 0; i < numFrames; i++) {
      let s = Math.max(-1, Math.min(1, pcm[i]));
      dv.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return new Blob([dv], { type: "audio/wav" });

    function writeStr(dv, offset, str) {
      for (let i = 0; i < str.length; i++) {
        dv.setUint8(offset + i, str.charCodeAt(i));
      }
    }
  }

  function concatFloat32(chunks) {
    const total = chunks.reduce((sum, a) => sum + a.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const a of chunks) {
      out.set(a, offset);
      offset += a.length;
    }
    return out;
  }

  function createAudioContext(sampleRate = 44100) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("Web Audio API is not supported in this browser");
    }

    try {
      return new AudioCtx({ sampleRate });
    } catch (err) {
      // 一部ブラウザでは sampleRate オプションが未対応なので、フォールバックする
      console.warn("createAudioContext: fallback without explicit sampleRate", err);
      return new AudioCtx();
    }
  }

  // ストリーミング復調時の状態を保持するためのクラス。
  //
  //  - buffer:     まだ解析していない生PCMデータ。
  //  - bitBuffer:  復調途中のビット列（0/1）。
  //  - inFrame:    現在フレーム（＝有効データ列）を復調中か。
  //  - expectedLength:  ヘッダーなどから分かる予定ビット数。
  //  - samplesProcessed: これまでに処理し終えて破棄したサンプル数。
  class FSKDemodState {
    constructor({
      fs,
      br,
      f0,
      f1,
      threshold = 1.4,
      expectedLength = null,
      usePre = false,
      preSec = 0
    }) {
      this.fs = fs;
      this.br = br;
      this.f0 = f0;
      this.f1 = f1;
      this.threshold = threshold;
      this.expectedLength = expectedLength;
      this.usePre = usePre;
      this.preSec = preSec;

      this.buffer = new Float32Array(0);
      this.bitBuffer = [];
      this.inFrame = false;

      this.samplesPerBit = Math.max(1, Math.round(fs / br));
      this.invFs = 1 / fs;
      this.twoPi = 2 * Math.PI;

      this.skipSamplesRemaining = usePre && preSec > 0
        ? Math.floor(preSec * fs)
        : 0;
      this.samplesProcessed = 0; // これまで破棄済みサンプル数
    }
  }

  function appendFloat32Buffers(a, b) {
    if (!a || a.length === 0) {
      return b.length ? new Float32Array(b) : new Float32Array(0);
    }
    if (!b || b.length === 0) {
      return new Float32Array(a);
    }
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function normalizeBuffer(buf) {
    const out = new Float32Array(buf.length);
    if (buf.length === 0) return out;

    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length) || 1;
    const g = 0.5 / rms;
    for (let i = 0; i < buf.length; i++) {
      let v = buf[i] * g;
      if (v > 1) v = 1;
      if (v < -1) v = -1;
      out[i] = v;
    }
    return out;
  }

  // 小さなPCMチャンクを受け取り、状態を更新しながら復調する。
  // フレームが完成すると number[] で返し、未完了なら null を返す。
  function demodFSKChunk(pcmChunk, state) {
    if (!state) {
      throw new Error("demodFSKChunk requires a valid FSKDemodState");
    }

    const chunk = pcmChunk && pcmChunk.length ? pcmChunk : new Float32Array(0);
    const combined = appendFloat32Buffers(state.buffer, chunk);
    const baseSampleOffset = state.samplesProcessed;

    if (combined.length === 0) {
      state.buffer = combined;
      return null;
    }

    const normalized = normalizeBuffer(combined);

    let idx = 0;

    if (!state.inFrame && state.skipSamplesRemaining > 0) {
      const skip = Math.min(state.skipSamplesRemaining, combined.length);
      idx = skip;
      state.skipSamplesRemaining -= skip;
      if (state.skipSamplesRemaining > 0) {
        // まだフレーム開始前。スキップ分だけ破棄して終了。
        const consumed = idx;
        state.samplesProcessed = baseSampleOffset + consumed;
        state.buffer = combined.slice(consumed);
        return null;
      }
    }

    if (!state.inFrame && state.skipSamplesRemaining === 0) {
      state.inFrame = true;
    }

    if (!state.inFrame) {
      state.samplesProcessed = baseSampleOffset + idx;
      state.buffer = combined.slice(idx);
      return null;
    }

    const samplesPerBit = state.samplesPerBit;
    const invFs = state.invFs;
    const TWO_PI = state.twoPi;

    let bitsCompleted = null;

    while (idx + samplesPerBit <= normalized.length) {
      let c0 = 0, s0 = 0;
      let c1 = 0, s1 = 0;

      for (let n = 0; n < samplesPerBit; n++) {
        const sampleIdx = idx + n;
        const sample = normalized[sampleIdx];
        const absoluteIdx = baseSampleOffset + sampleIdx;
        const t = absoluteIdx * invFs;

        const w0 = TWO_PI * state.f0 * t;
        const w1 = TWO_PI * state.f1 * t;

        const cos0 = Math.cos(w0);
        const sin0 = Math.sin(w0);
        const cos1 = Math.cos(w1);
        const sin1 = Math.sin(w1);

        c0 += sample * cos0;
        s0 += sample * sin0;
        c1 += sample * cos1;
        s1 += sample * sin1;
      }

      const p0 = c0 * c0 + s0 * s0;
      const p1 = c1 * c1 + s1 * s1;
      const ratio = (p1 + 1e-12) / (p0 + 1e-12);

      let bit;
      if (ratio > state.threshold) {
        bit = 1;
      } else if (ratio < 1 / state.threshold) {
        bit = 0;
      } else {
        bit = p1 >= p0 ? 1 : 0;
      }

      state.bitBuffer.push(bit);
      idx += samplesPerBit;

      if (
        state.expectedLength != null &&
        state.bitBuffer.length >= state.expectedLength
      ) {
        const complete = state.bitBuffer.slice(0, state.expectedLength);
        state.bitBuffer = state.bitBuffer.slice(state.expectedLength);
        state.inFrame = false;
        state.expectedLength = null;
        bitsCompleted = complete;
        break;
      }
    }

    const consumed = idx;
    state.samplesProcessed = baseSampleOffset + consumed;
    state.buffer = combined.slice(consumed);

    if (!state.inFrame && state.bitBuffer.length === 0) {
      // フレーム外のノイズが溜まりすぎないように古い部分を間引く
      const maxKeep = state.samplesPerBit * 8;
      if (state.buffer.length > maxKeep) {
        const trim = state.buffer.length - maxKeep;
        state.buffer = state.buffer.slice(trim);
        state.samplesProcessed += trim;
      }
    }

    return bitsCompleted;
  }

  function demodFSK(raw, fs, br, f0, f1, bitsExpected, usePre, th, preSec) {
    debugLog(
      `demodFSK: fs=${fs}, br=${br}, f0=${f0}, f1=${f1}, len=${raw.length}`
    );

    const samplesPerBit = Math.max(1, Math.round(fs / br));
    const start = usePre && preSec > 0 ? Math.min(raw.length, Math.floor(preSec * fs)) : 0;
    const maxBits = Math.floor((raw.length - start) / samplesPerBit);
    const totalBits = bitsExpected ? Math.min(bitsExpected, maxBits) : maxBits;

    debugLog(
      `demodFSK: samplesPerBit=${samplesPerBit}, start=${start}, totalBits=${totalBits}`
    );

    const state = new FSKDemodState({
      fs,
      br,
      f0,
      f1,
      threshold: th || 1.4,
      expectedLength: totalBits,
      usePre,
      preSec
    });

    // start に達するまではサンプルを空読みしてスキップする
    if (start > 0) {
      state.skipSamplesRemaining = start;
    }

    const chunkSize = Math.max(samplesPerBit * 16, 1024);
    const frames = [];

    for (let i = 0; i < raw.length; i += chunkSize) {
      const sub = raw.subarray(i, Math.min(i + chunkSize, raw.length));
      const result = demodFSKChunk(sub, state);
      if (result && result.length) {
        frames.push(result);
      }
    }

    const finalResult = demodFSKChunk(new Float32Array(0), state);
    if (finalResult && finalResult.length) {
      frames.push(finalResult);
    }

    const flattened = [];
    for (const frame of frames) {
      for (const bit of frame) {
        flattened.push(bit);
      }
    }
    const allBits = flattened.map((b) => (b ? "1" : "0")).join("");
    debugLog(`demodFSK: decoded bits length = ${allBits.length}`);
    return { bits: allBits };
  }

  // グローバルにまとめてぶら下げる
  global.SoundComm = {
    debugLog,
    pcmToWavBlob,
    concatFloat32,
    createAudioContext,
    demodFSK,
    FSKDemodState,
    demodFSKChunk
  };
})(window);
