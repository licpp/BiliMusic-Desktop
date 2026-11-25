package app.bilimusic.player

internal enum class FloatingLyricsLanguage(val value: String, val label: String) {
    ORIGINAL("original", "原文"),
    TRANSLATION("translation", "译文"),
    BILINGUAL("bilingual", "双语");

    fun next() = entries[(ordinal + 1) % entries.size]

    companion object {
        fun parse(value: String?) = entries.firstOrNull { it.value == value }
    }
}
