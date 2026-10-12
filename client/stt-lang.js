// Выбор языка записи по вероятностям Whisper (Map язык → вероятность) с учётом языков пользователя.
// Короткую или нечёткую запись модель путает с соседним языком (русский — с украинским,
// польским…): если язык пользователя тоже вероятен — берём его; а если модель вообще не уверена
// (самый вероятный язык — меньше половины), язык пользователя — лучшая догадка.
export function chooseLanguage(prob, prefer = []) {
  let best = null;
  let top = -1;
  for (const [l, p] of prob) if (p > top) (top = p), (best = l);
  if (best == null || prefer.includes(best)) return best;
  const pick = prefer.find((l) => prob.has(l) && (top < 0.5 || (prob.get(l) >= 0.12 && prob.get(l) >= top / 4)));
  return pick || best;
}
