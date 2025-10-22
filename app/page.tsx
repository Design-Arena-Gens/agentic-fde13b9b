"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";

type VoicePreset =
  | "alloy"
  | "verse"
  | "aria"
  | "bright"
  | "calypso"
  | "lively"
  | "sage"
  | "soft";

type Step =
  | "idle"
  | "preparing"
  | "extracting"
  | "segmenting"
  | "transcribing"
  | "translating"
  | "synthesizing"
  | "concatenating"
  | "muxing"
  | "done";

export default function Page() {
  const [apiKey, setApiKey] = useState("");
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [targetLang, setTargetLang] = useState("es");
  const [voice, setVoice] = useState<VoicePreset>("alloy");
  const [status, setStatus] = useState<Step>("idle");
  const [detail, setDetail] = useState("");
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [maxMinutes, setMaxMinutes] = useState(45);

  const ffmpegRef = useRef<FFmpeg | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("openai_api_key");
    if (saved) setApiKey(saved);
  }, []);

  useEffect(() => {
    if (apiKey) localStorage.setItem("openai_api_key", apiKey);
  }, [apiKey]);

  const ffmpeg = useMemo(() => ffmpegRef.current as FFmpeg, []);

  async function ensureFFmpeg() {
    if (!ffmpegRef.current) {
      setStatus("preparing");
      setDetail("Loading ffmpeg.wasm (~25MB)...");
      const instance = new FFmpeg();
      ffmpegRef.current = instance;
      // Progress callback
      instance.on("progress", ({ progress }) => {
        if (typeof progress === "number") setProgress(Math.min(99, Math.round(progress * 100)));
      });
      await instance.load();
      return;
    }
    if (!ffmpegRef.current.loaded) {
      await ffmpegRef.current.load();
    }
  }

  function fmt(s: number) {
    return s.toFixed(1);
  }

  async function handleStart() {
    setDownloadUrl(null);
    if (!apiKey) throw new Error("Missing OpenAI API key");
    if (!videoFile) throw new Error("No video uploaded");

    await ensureFFmpeg();

    // Reset FS
    try { await ffmpeg.deleteFile("input.mp4"); } catch {}
    try { await ffmpeg.deleteFile("audio.wav"); } catch {}

    setStatus("extracting");
    setDetail("Extracting audio track...");

    // progress handled via ffmpeg.on("progress")

    const inputName = videoFile.name.endsWith(".webm") ? "input.webm" : "input.mp4";
    await ffmpeg.writeFile(inputName, await fetchFile(videoFile));

    // Extract mono 16k wav for ASR
    await ffmpeg.exec(["-i", inputName, "-vn", "-ac", "1", "-ar", "16000", "audio.wav"]);

    setStatus("segmenting");
    setDetail("Segmenting audio into 60s chunks...");

    // Create segments of ~60s using ffmpeg segment muxer
    try { await ffmpeg.deleteFile("segments.txt"); } catch {}
    await ffmpeg.exec(["-i", "audio.wav", "-f", "segment", "-segment_time", "60", "-c", "copy", "seg_%03d.wav"]);

    // List segments
    const entries = await ffmpeg.listDir("/");
    const files = entries.map(e => e.name).filter(n => n.startsWith("seg_") && n.endsWith(".wav")).sort();
    if (files.length === 0) throw new Error("No segments produced");

    // Cap by maxMinutes
    const maxSegments = Math.min(files.length, Math.ceil(maxMinutes));
    const usedSegments = files.slice(0, maxSegments);

    // Process each: transcribe -> translate -> TTS -> save as wav
    setStatus("transcribing");

    const dubbedSegmentNames: string[] = [];

    for (let i = 0; i < usedSegments.length; i++) {
      const segName = usedSegments[i];
      setDetail(`Processing segment ${i + 1}/${usedSegments.length}`);
      setProgress(Math.round(((i) / usedSegments.length) * 100));

      const segData = await ffmpeg.readFile(segName);
      const segBlob = new Blob([segData as Uint8Array], { type: "audio/wav" });

      // 1) Transcribe
      const transcript = await transcribeWithOpenAI(apiKey, segBlob);

      // 2) Translate
      const translated = await translateWithOpenAI(apiKey, transcript, targetLang);

      // 3) TTS
      const ttsWav = await ttsWithOpenAI(apiKey, translated, voice);

      // 4) Save dubbed wav to FS
      const outName = `tts_${segName}`;
      const ttsBuf = new Uint8Array(await ttsWav.arrayBuffer());
      try { await ffmpeg.deleteFile(outName); } catch {}
      await ffmpeg.writeFile(outName, ttsBuf);
      dubbedSegmentNames.push(outName);
    }

    // Concat TTS wavs
    setStatus("concatenating");
    setDetail("Concatenating synthesized audio...");

    // Write concat list file
    const listContent = dubbedSegmentNames.map(n => `file '${n}'`).join("\n");
    await ffmpeg.writeFile("concat.txt", listContent);

    await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "concat.txt", "-c", "copy", "dubbed.wav"]);

    // Mux with original video -> WebM
    setStatus("muxing");
    setDetail("Muxing dubbed audio into WebM video (this can take a while)...");

    try { await ffmpeg.deleteFile("output.webm"); } catch {}

    await ffmpeg.exec([
      "-i", inputName,
      "-i", "dubbed.wav",
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libvpx",
      "-crf", "32",
      "-b:v", "0",
      "-c:a", "libopus",
      "-shortest",
      "output.webm"
    ]);

    const outData = await ffmpeg.readFile("output.webm");
    const blob = new Blob([outData as Uint8Array], { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    setDownloadUrl(url);

    setStatus("done");
    setProgress(100);
    setDetail("Completed");
  }

  return (
    <main>
      <h1>AI Video Dubbing</h1>
      <p className="small">All processing runs in your browser using ffmpeg.wasm. For transcription/translation/TTS, your OpenAI API key is used directly from your device.</p>

      <section>
        <div className="grid">
          <div>
            <label>OpenAI API Key</label>
            <input
              type="text"
              placeholder="sk-..."
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="small">Stored locally in your browser only.</p>
          </div>
          <div>
            <label>Target language</label>
            <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="hi">Hindi</option>
              <option value="ja">Japanese</option>
              <option value="ko">Korean</option>
              <option value="zh">Chinese (Simplified)</option>
              <option value="ar">Arabic</option>
            </select>
            <label>Voice</label>
            <select value={voice} onChange={(e) => setVoice(e.target.value as VoicePreset)}>
              <option value="alloy">Alloy</option>
              <option value="verse">Verse</option>
              <option value="aria">Aria</option>
              <option value="bright">Bright</option>
              <option value="calypso">Calypso</option>
              <option value="lively">Lively</option>
              <option value="sage">Sage</option>
              <option value="soft">Soft</option>
            </select>
          </div>
        </div>

        <div className="grid" style={{ marginTop: 12 }}>
          <div>
            <label>Video file (MP4/WebM)</label>
            <input type="file" accept="video/mp4,video/webm" onChange={(e) => setVideoFile(e.target.files?.[0] || null)} />
          </div>
          <div>
            <label>Max minutes to process</label>
            <input type="number" min={1} max={300} value={maxMinutes} onChange={(e)=> setMaxMinutes(parseInt(e.target.value || "45"))} />
            <p className="small">Long videos can take a long time; this limits processed duration.</p>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button disabled={!apiKey || !videoFile || status === "preparing" || status === "extracting" || status === "segmenting" || status === "transcribing" || status === "translating" || status === "synthesizing" || status === "concatenating" || status === "muxing"} onClick={handleStart}>Start dubbing</button>
          {downloadUrl && (
            <a href={downloadUrl} download="dubbed.webm"><button>Download dubbed video</button></a>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="progress"><div style={{ width: `${progress}%` }} /></div>
          <p style={{ margin: 8 }} className="mono">{status.toUpperCase()} {detail ? `- ${detail}` : null}</p>
        </div>

        {downloadUrl && (
          <div style={{ marginTop: 12 }}>
            <h2>Preview</h2>
            <video src={downloadUrl} controls style={{ width: "100%", borderRadius: 8 }} />
          </div>
        )}
      </section>
    </main>
  );
}

async function transcribeWithOpenAI(apiKey: string, audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", audio, "audio.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "json");
  // Language auto-detect; for speed you can hint with "language"

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });
  if (!res.ok) throw new Error(`Transcription failed: ${res.status}`);
  const data = await res.json();
  return data.text as string;
}

async function translateWithOpenAI(apiKey: string, text: string, targetLang: string): Promise<string> {
  const sys = `You are a professional media translator. Translate the user's text to ${targetLang} for voice dubbing. Keep meaning and tone. Do not add extra commentary. Output only the translation.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: text }
      ],
      temperature: 0.3
    })
  });
  if (!res.ok) throw new Error(`Translation failed: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function ttsWithOpenAI(apiKey: string, text: string, voice: VoicePreset): Promise<Blob> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      voice,
      input: text,
      format: "wav"
    })
  });
  if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
  const arrayBuf = await res.arrayBuffer();
  return new Blob([arrayBuf], { type: "audio/wav" });
}
