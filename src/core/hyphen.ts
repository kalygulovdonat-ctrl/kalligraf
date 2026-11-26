// Перенос слов по слогам для русского и кыргызского (и простой — для английского).
// Правила: между гласными делим по стечению согласных; «й», «ь», «ъ» не отрываем
// от предыдущей буквы; на строке и на переносе остаётся не меньше 2 букв.

const VOWELS = new Set('аеёиоуыэюяөүaeiouyАЕЁИОУЫЭЮЯӨҮAEIOUY');
const ATTACH = new Set('йьъЙЬЪ');
const isLetter = (c: string) => /\p{L}/u.test(c);

/** Возвращает индексы, перед которыми можно поставить перенос. */
export function hyphenPoints(word: string): number[] {
  const chars = [...word];
  const n = chars.length;
  // Переносим только кириллические слова: для английского простые правила дают ошибки
  if (n < 4 || !chars.every(isLetter) || !/[а-яёөүң]/i.test(word)) return [];
  const vowelIdx: number[] = [];
  chars.forEach((c, i) => { if (VOWELS.has(c)) vowelIdx.push(i); });
  const points: number[] = [];
  for (let k = 0; k < vowelIdx.length - 1; k++) {
    const a = vowelIdx[k], b = vowelIdx[k + 1];
    const cluster = b - a - 1;
    let cut: number;
    if (cluster === 0) cut = b;
    else if (cluster === 1) cut = a + 1;
    else cut = a + 2; // после первой согласной стечения
    while (cut < n && ATTACH.has(chars[cut])) cut++;
    if (cut >= 2 && n - cut >= 2 && cut > a && cut <= b) points.push(cut);
  }
  return [...new Set(points)];
}

/** Делит слово на две части, чтобы первая (с дефисом) не превышала maxWidth. */
export function splitForWidth(
  word: string,
  measure: (s: string) => number,
  maxWidth: number,
): [string, string] | null {
  const chars = [...word];
  const pts = hyphenPoints(word).sort((x, y) => y - x);
  for (const p of pts) {
    const head = chars.slice(0, p).join('') + '-';
    if (measure(head) <= maxWidth) return [head, chars.slice(p).join('')];
  }
  return null;
}
