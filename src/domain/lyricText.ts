import { Converter } from 'opencc-js/t2cn'

// Conversion is for comparison only. Displayed lyrics and their timings stay intact.
export const simplifiedLyricText = Converter({ from: 't', to: 'cn' })

const credits = /^(?:(?:作[词曲](?:OP|SP)?|[词曲]|词曲|编曲|制作人?|配唱制作|演唱|和[音声]|吉他|贝[司斯]|鼓|弦乐(?:编写|监制|录音(?:师|棚)?)?|乐[队谱](?:监制)?|录[音影](?:师|室|棚)?|人声(?:录音(?:师|棚)?|编辑)|混音(?:[&＆]母带)?|母带|发行|字幕)|lyrics?\s*(?:by)?|music\s*by)\s*[:：]/i
export const isLyricCredit = (value: string) => credits.test(simplifiedLyricText(value).trim())
