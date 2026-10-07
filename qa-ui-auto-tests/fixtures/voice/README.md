# Chinese speech fixture

`fleurs-cmn-hans-cn-1906.wav` is an **unmodified** recording from the
[Google FLEURS dataset](https://huggingface.co/datasets/google/fleurs),
configuration `cmn_hans_cn`, test split, ID `1906`, filename
`10026684690566417990.wav`. Attribution: Google FLEURS / FLEURS contributors.
License: [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
It is a public human speech sample, not microphone capture from this workstation.

Source revision: `70bb2e84b976b7e960aa89f1c648e09c59f894dd`.

- [Audio archive](https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/cmn_hans_cn/audio/test.tar.gz)
- [Independent reference transcript](https://huggingface.co/datasets/google/fleurs/resolve/70bb2e84b976b7e960aa89f1c648e09c59f894dd/data/cmn_hans_cn/test.tsv)
- WAV SHA-256: `a72c0b59fdba80850552af7991de07f9f4940846d2d70f0890eeb153c40f164b`
- Source TSV SHA-256: `5734461648f816181d7dab5fc79204b18c4b9bc2cd5138225b25c72d18385d21`
- Format: 16 kHz mono IEEE float32 WAV, 166080 samples, 10.38 seconds.

Reference text from the TSV:

> “这并不是告别。这是一个篇章的结束，也是新篇章的开始。”

`scripts/voice-fixture.py` verifies the WAV hash and extracts its existing PCM
payload into the isolated test cache without modifying the committed recording.
The native test removes punctuation, normalizes the traditional variants in this
sentence, and requires CER <= 0.25. This is a short multilingual Base smoke test;
it is not an aggregate Mandarin accuracy claim. Retain the raw transcript and
measured CER, including errors; do not change the reference to match model output.
