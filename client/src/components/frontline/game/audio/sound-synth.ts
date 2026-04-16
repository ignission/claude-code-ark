// FrontLine サウンド — fetch+decodeAudioDataで事前デコード、即時再生（ラグなし）

const buffers = new Map<string, AudioBuffer>();
let ctx: AudioContext | null = null;
let initPromise: Promise<void> | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

const SOUND_FILES: Record<string, string> = {
  handgun: "/sounds/handgun.ogg",
  machinegun: "/sounds/machinegun.ogg",
  shotgun: "/sounds/shotgun.ogg",
  sniper: "/sounds/sniper.ogg",
  reload: "/sounds/reload.ogg",
  explosion: "/sounds/explosion.ogg",
  hit: "/sounds/hit.ogg",
  headshot: "/sounds/headshot.ogg",
  defend: "/sounds/defend.ogg",
  grenade_throw: "/sounds/grenade_throw.ogg",
};

/** GameScene create()で呼び出し。全サウンドをfetch+デコードしてバッファに格納（一度だけ） */
export function initSoundSystem(): Promise<void> {
  if (initPromise) return initPromise;
  const audioCtx = getCtx();
  initPromise = Promise.all(
    Object.entries(SOUND_FILES).map(([key, url]) =>
      fetch(url)
        .then(r => r.arrayBuffer())
        .then(ab => audioCtx.decodeAudioData(ab))
        .then(buf => buffers.set(key, buf))
        .catch(() => {})
    )
  ).then(() => {});
  return initPromise;
}

function play(key: string, volume = 0.5, rate = 1.0): void {
  const buf = buffers.get(key);
  if (!buf) return;
  const audioCtx = getCtx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const src = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  src.buffer = buf;
  src.playbackRate.value = rate;
  gain.gain.value = volume;
  src.connect(gain).connect(audioCtx.destination);
  src.start(0);
}

export const SoundSynth = {
  handgunShot(): void {
    play("handgun", 0.4);
  },

  machinegunShot(): void {
    play("machinegun", 0.35, 1.0 + Math.random() * 0.15);
  },

  shotgunShot(): void {
    play("shotgun", 0.5);
  },

  sniperShot(): void {
    play("sniper", 0.5);
  },

  reload(): void {
    play("reload", 0.35);
  },

  hit(): void {
    play("hit", 0.4, 0.9 + Math.random() * 0.2);
  },

  explosion(): void {
    play("explosion", 0.6);
  },

  headshot(): void {
    play("headshot", 0.5);
  },

  defend(): void {
    play("defend", 0.4, 0.9 + Math.random() * 0.2);
  },

  grenadeThrow(): void {
    play("grenade_throw", 0.3);
  },

  medal(): void {
    const audioCtx = getCtx();
    const notes = [523, 659, 784];
    for (let i = 0; i < notes.length; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.15;
      osc.type = "sine";
      osc.frequency.value = notes[i];
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.25);
    }
  },
} as const;
