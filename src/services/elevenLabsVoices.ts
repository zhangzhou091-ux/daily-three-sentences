/**
 * ElevenLabs 美式英语语音配置
 *
 * 基于官方 Current Default Voices，按听力学习优先级排列
 * 来源: https://elevenlabs.io/docs/product/voices/default-voices
 */

export interface VoiceEntry {
  voice_id: string;
  name: string;
  accent: string;
  gender: string;
  description: string;
  use_case: string;
}

export const DEFAULT_VOICES: VoiceEntry[] = [
  // === 听力学习首选 ===
  { voice_id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam',    accent: 'american', gender: 'male',   description: 'articulate narration',      use_case: 'narration'      },
  { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah',   accent: 'american', gender: 'female', description: 'soft news',                use_case: 'news'           },
  { voice_id: 'iP95p4xoKVk53GoZ742B', name: 'Chris',   accent: 'american', gender: 'male',   description: 'casual conversational',     use_case: 'conversational' },
  // === 美式英语备用 ===
  { voice_id: 'FGY2WhTYpKnrIDTdsKH5', name: 'Laura',   accent: 'american', gender: 'female', description: 'upbeat social media',       use_case: 'social_media'   },
  { voice_id: 'XrExE9yKIg1WjnnlVkGX', name: 'Matilda', accent: 'american', gender: 'female', description: 'friendly narration',       use_case: 'narration'      },
  { voice_id: 'bIHbv24MWmeRgasZH58o', name: 'Will',    accent: 'american', gender: 'male',   description: 'friendly social media',     use_case: 'social_media'   },
  { voice_id: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', accent: 'american', gender: 'female', description: 'expressive conversational', use_case: 'conversational' },
  { voice_id: 'cjVigY5qzO86Huf0OWal', name: 'Eric',    accent: 'american', gender: 'male',   description: 'friendly conversational',   use_case: 'conversational' },
  { voice_id: 'pqHfZKP75CvOlQylNhV4', name: 'Bill',    accent: 'american', gender: 'male',   description: 'trustworthy narration',      use_case: 'narration'      },
  { voice_id: 'nPczCjzI2devNBz1zQrb', name: 'Brian',   accent: 'american', gender: 'male',   description: 'deep narration',             use_case: 'narration'      },
  { voice_id: '9BWtsMINqrJLrRacOk9x', name: 'Aria',    accent: 'american', gender: 'female', description: 'expressive social media',    use_case: 'social_media'   },
  { voice_id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger',   accent: 'american', gender: 'male',   description: 'confident social media',     use_case: 'social_media'   },
  { voice_id: 'SAz9YHcvj6GT2YYXdXww', name: 'River',   accent: 'american', gender: 'neutral',description: 'confident social media',    use_case: 'social_media'   },
  // === 英式英语（非听力首选，供对比学习） ===
  { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice',   accent: 'british',  gender: 'female', description: 'confident news',           use_case: 'news'           },
  { voice_id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel',  accent: 'british',  gender: 'male',   description: 'authoritative news',        use_case: 'news'           },
  { voice_id: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily',    accent: 'british',  gender: 'female', description: 'warm narration',            use_case: 'narration'      },
  { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George',  accent: 'british',  gender: 'male',   description: 'warm narration',            use_case: 'narration'      },
];

/** 听力学习推荐的语音 ID，取 DEFAULT_VOICES 前三 */
export const RECOMMENDED_VOICE_IDS: string[] = DEFAULT_VOICES.slice(0, 3).map(v => v.voice_id);
