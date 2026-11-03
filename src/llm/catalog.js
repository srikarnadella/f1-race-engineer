// Ask the race (roadmap L3): the models the app offers to download. Small enough to run on a 4 GB
// GPU (a GTX 1650) and able to call tools, which is how they get their facts (src/llm/tools.js).
// Gemma 3 was on the first list but has no tool calling in Ollama. L4's question set trims this list.
// Sizes are Ollama's download sizes (the default 4-bit builds).
const MODELS = [
  {
    id: 'qwen3:1.7b', name: 'Qwen3 1.7B', maker: 'Alibaba Qwen', sizeBytes: 1.4e9,
    licence: 'Apache 2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen3-1.7B/blob/main/LICENSE',
    note: 'The quickest. Fine for "what was my best lap?", weaker on why.',
  },
  {
    id: 'qwen3:4b', name: 'Qwen3 4B', maker: 'Alibaba Qwen', sizeBytes: 2.5e9,
    licence: 'Apache 2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen3-4B/blob/main/LICENSE',
    note: 'The best answers that fit in 4 GB, a little slower.',
  },
  {
    id: 'llama3.2:3b', name: 'Llama 3.2 3B', maker: 'Meta', sizeBytes: 2.0e9,
    licence: 'Llama 3.2 Community License', licenceUrl: 'https://www.llama.com/llama3_2/license/',
    note: 'Quick and steady with tools.',
  },
  {
    id: 'phi4-mini', name: 'Phi-4-mini', maker: 'Microsoft', sizeBytes: 2.5e9,
    licence: 'MIT', licenceUrl: 'https://huggingface.co/microsoft/Phi-4-mini-instruct/blob/main/LICENSE',
    note: 'Good at numbers and reasoning over them.',
  },
];

const isOffered = (id) => MODELS.some((m) => m.id === id);

module.exports = { MODELS, isOffered };
