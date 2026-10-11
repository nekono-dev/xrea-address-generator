// ランダムな名前の生成。単語2つをピリオドで区切り、数字2桁を直結する（例: quiet.river42）。
export function randomName(words: readonly string[], rnd: () => number = Math.random): string {
  const w = () => words[Math.floor(rnd() * words.length)]
  return `${w()}.${w()}${10 + Math.floor(rnd() * 90)}`
}
