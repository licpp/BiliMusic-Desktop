package app.bilimusic.player

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.roundToInt

internal class FloatingLyricsToolbar(context: Context, private val onAction: (Action) -> Unit) : LinearLayout(context) {
    enum class Action { LANGUAGE, SMALLER, LARGER, LOCK, CLOSE }

    private val ink = 0xFFD8E5EF.toInt()
    private val accent = 0xFFB4F3E9.toInt()
    private val languageButton = LinearLayout(context)
    private val languageLabel = TextView(context)
    private val languageDivider: View
    private val smallerButton = iconButton(FloatingControlIcon.Kind.MINUS, "减小歌词字号", Action.SMALLER)
    private val largerButton = iconButton(FloatingControlIcon.Kind.PLUS, "增大歌词字号", Action.LARGER)

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), dp(2), dp(4), dp(2))
        background = GradientDrawable().apply {
            setColor(0xEB122434.toInt())
            setStroke(dp(1), 0x3DC4D9E7)
            cornerRadius = dp(16).toFloat()
        }
        languageButton.apply {
            gravity = Gravity.CENTER
            isBaselineAligned = false
            background = InsetDrawable(feedback(0x244DE0D3), 0, dp(5), 0, dp(5))
            setOnClickListener { onAction(Action.LANGUAGE) }
            isFocusable = true
            val icon = ImageView(context).apply {
                setImageDrawable(FloatingControlIcon(FloatingControlIcon.Kind.LANGUAGE).apply { setTint(accent) })
                // Align the icon's visible strokes with the adjacent text.
                translationY = resources.displayMetrics.density
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            addView(icon, LayoutParams(dp(17), dp(17)))
            languageLabel.apply {
                gravity = Gravity.CENTER_VERTICAL
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                includeFontPadding = false
                setTextSize(13f)
                setTextColor(accent)
                typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            addView(languageLabel, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.MATCH_PARENT).apply { marginStart = dp(5) })
        }
        addView(languageButton, LayoutParams(dp(76), dp(44)))
        languageDivider = divider()
        addView(smallerButton, buttonSize())
        addView(largerButton, buttonSize())
        divider()
        addView(iconButton(FloatingControlIcon.Kind.LOCK, "锁定悬浮歌词", Action.LOCK), buttonSize())
        addView(iconButton(FloatingControlIcon.Kind.CLOSE, "关闭悬浮歌词", Action.CLOSE), buttonSize())
        displayLanguage(FloatingLyricsLanguage.ORIGINAL)
        showLanguage(false)
    }

    fun showLanguage(available: Boolean) {
        val state = if (available) View.VISIBLE else View.GONE
        languageButton.visibility = state
        languageDivider.visibility = state
    }

    fun displayLanguage(language: FloatingLyricsLanguage) {
        languageLabel.text = language.label
        languageButton.contentDescription = "悬浮歌词显示${language.label}，点击切换"
    }

    fun displayFontSize(size: Float) {
        smallerButton.isEnabled = size > 18f
        largerButton.isEnabled = size < 48f
        smallerButton.imageAlpha = if (smallerButton.isEnabled) 255 else 105
        largerButton.imageAlpha = if (largerButton.isEnabled) 255 else 105
    }

    private fun iconButton(icon: FloatingControlIcon.Kind, description: String, action: Action) =
        ImageButton(context).apply {
            val padding = dp(12)
            scaleType = ImageView.ScaleType.FIT_CENTER
            setImageDrawable(FloatingControlIcon(icon).apply { setTint(ink) })
            background = InsetDrawable(feedback(), dp(3))
            setPadding(padding, padding, padding, padding)
            contentDescription = description
            setOnClickListener { onAction(action) }
        }

    private fun divider(): View {
        val space = LayoutParams(dp(1), dp(18)).apply { marginStart = dp(2); marginEnd = dp(2) }
        return View(context).apply {
            setBackgroundColor(0x32C4D9E7)
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            addView(this, space)
        }
    }

    private fun buttonSize() = LayoutParams(dp(44), dp(44))

    private fun feedback(fill: Int = 0) = RippleDrawable(
        ColorStateList.valueOf(0x40D8E5EF),
        if (fill == 0) null else rounded(fill),
        rounded(0xFFFFFFFF.toInt())
    )

    private fun rounded(color: Int) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(10).toFloat()
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()
}
