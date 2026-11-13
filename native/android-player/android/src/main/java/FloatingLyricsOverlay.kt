package app.bilimusic.player

import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ReplacementSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.ImageButton
import android.view.View
import android.os.Build
import android.hardware.input.InputManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

// The service owns the renderer and reads the same MediaPlayer clock. No
// WebView timer or second audio session is needed when the app is backgrounded.
object FloatingLyricsOverlay {
    var enabled = false
        private set
    private var owner: PlaybackService? = null
    private var view: LinearLayout? = null
    private var text: ScrollingLyricView? = null
    private var nextText: ScrollingLyricView? = null
    var styleRevision = 0L
        private set
    var fontSize = 28f
        private set
    var locked = false
        private set
    private var activeColor=0xFFB4F3E9.toInt()
    private var inactiveColor=0xFF91A6B5.toInt()
    private var layout: WindowManager.LayoutParams? = null
    private var unlock: ImageButton? = null
    private var unlockLayout: WindowManager.LayoutParams? = null
    private var controls: LinearLayout? = null
    private var controlsUntil = 0L
    private var data = JSONObject()
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() { if (enabled) { render(); controls?.visibility=if(!locked && android.os.SystemClock.uptimeMillis()<controlsUntil) android.view.View.VISIBLE else android.view.View.GONE; handler.postDelayed(this,33) } }
    }
    fun attach(service: PlaybackService) { owner=service; if(enabled) show() }
    fun detach() { hide(); owner=null; enabled=false }
    fun command(context: Context, raw: String): JSONObject {
        require(raw.length <= 1_000_000)
        val args=JSONObject(raw)
        when(args.optString("action")) {
            "configure" -> {
                fontSize=args.optDouble("fontSize",fontSize.toDouble()).toFloat().coerceIn(18f,48f);locked=args.optBoolean("locked",locked)
                fun color(key:String,fallback:Int)=args.optString(key).takeIf{it.matches(Regex("#[0-9a-fA-F]{6}"))}?.let{Color.parseColor(it)} ?: fallback
                activeColor=color("activeColor",activeColor);inactiveColor=color("inactiveColor",inactiveColor)
                text?.textSize=fontSize;nextText?.textSize=fontSize;text?.setTextColor(activeColor);nextText?.setTextColor(inactiveColor)
                applyLock(context)
            }
            "update" -> { data=args; render() }
            "enable" -> {
                if(args.optBoolean("enabled") && !Settings.canDrawOverlays(context)) {
                    if(args.optBoolean("requestPermission")) context.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    return status(context).put("reason","请允许悬浮窗权限，然后重新开启")
                }
                enabled=args.optBoolean("enabled")
                if(enabled) show() else hide()
            }
        }
        return status(context)
    }
    private fun status(context: Context)=JSONObject().put("supported",true).put("enabled",enabled).put("permissionRequired",!Settings.canDrawOverlays(context))
    private fun hide() {
        handler.removeCallbacks(tick)
        val context=owner
        hideUnlock()
        if(view!=null && context!=null) runCatching { (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(view) }
        view=null; text=null;nextText=null;controls=null;layout=null
    }
    private fun show() {
        val context=owner ?: return
        if(view!=null || !Settings.canDrawOverlays(context)) return
        val density=context.resources.displayMetrics.density
        val window=context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val row=LinearLayout(context).apply {
            orientation=LinearLayout.VERTICAL; gravity=Gravity.CENTER_VERTICAL
            setPadding((12*density).toInt(),(8*density).toInt(),(4*density).toInt(),(8*density).toInt())
            setBackgroundColor(Color.TRANSPARENT)
        }
        fun lyricLabel(size:Float)=ScrollingLyricView(context).apply { textSize=size;gravity=Gravity.START;setTextColor(activeColor);includeFontPadding=false;setLineSpacing(0f,1f);typeface=Typeface.create("sans-serif-medium",Typeface.NORMAL);setSingleLine(true);ellipsize=null;setShadowLayer(2*density,0f,1f,0x66000000) }
        val label=lyricLabel(fontSize);text=label;row.addView(label,LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT))
        val next=lyricLabel(fontSize).apply {gravity=Gravity.END;setTextColor(inactiveColor)};nextText=next;row.addView(next,LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT))
        val tools=LinearLayout(context).apply{orientation=LinearLayout.HORIZONTAL;gravity=Gravity.END;visibility=android.view.View.GONE;background=GradientDrawable().apply{setColor(0x99516A80.toInt());cornerRadius=8*density}};controls=tools
        fun button(icon:FloatingControlIcon.Kind,description:String,action:()->Unit){tools.addView(controlButton(context,icon,description){controlsUntil=android.os.SystemClock.uptimeMillis()+4000;action()},LinearLayout.LayoutParams((44*density).toInt(),(44*density).toInt()))}
        button(FloatingControlIcon.Kind.MINUS,"减小歌词字号"){fontSize=(fontSize-2).coerceAtLeast(18f);label.textSize=fontSize;next.textSize=fontSize;saveStyle(context)}
        button(FloatingControlIcon.Kind.PLUS,"增大歌词字号"){fontSize=(fontSize+2).coerceAtMost(48f);label.textSize=fontSize;next.textSize=fontSize;saveStyle(context)}
        button(FloatingControlIcon.Kind.LOCK,"锁定悬浮歌词"){locked=true;applyLock(context);saveStyle(context)}
        button(FloatingControlIcon.Kind.CLOSE,"关闭悬浮歌词"){enabled=false;hide();owner?.notifyLyricsChanged()}
        row.addView(tools,LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,LinearLayout.LayoutParams.WRAP_CONTENT))
        val metrics=context.resources.displayMetrics
        val params=WindowManager.LayoutParams((metrics.widthPixels*.9).toInt(),WindowManager.LayoutParams.WRAP_CONTENT,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,android.graphics.PixelFormat.TRANSLUCENT).apply { gravity=Gravity.TOP or Gravity.START;x=(metrics.widthPixels*.05).toInt();y=(metrics.heightPixels*.65).toInt() }
        if(locked)params.flags=params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        params.alpha=windowAlpha(context)
        layout=params
        var moved=false
        var initialX=0;var initialY=0;var downX=0f;var downY=0f
        val touch=android.view.View.OnTouchListener { _,event ->
            when(event.actionMasked) {
                MotionEvent.ACTION_DOWN -> { moved=false;initialX=params.x;initialY=params.y;downX=event.rawX;downY=event.rawY }
                MotionEvent.ACTION_MOVE -> { if(kotlin.math.abs(event.rawX-downX)+kotlin.math.abs(event.rawY-downY)>8*density)moved=true;params.x=(initialX+event.rawX-downX).toInt().coerceIn(0,(metrics.widthPixels-row.width).coerceAtLeast(0));params.y=(initialY+event.rawY-downY).toInt().coerceIn(0,(metrics.heightPixels-row.height).coerceAtLeast(0));runCatching {window.updateViewLayout(row,params)} }
                MotionEvent.ACTION_UP -> { if(!moved && !locked)controlsUntil=android.os.SystemClock.uptimeMillis()+4000 }
            };true
        }
        label.setOnTouchListener(touch);next.setOnTouchListener(touch)
        row.addOnLayoutChangeListener{_,_,_,_,_,_,_,_,_->syncUnlock()}
        row.setOnHoverListener{_,event->if(!locked)controlsUntil=if(event.actionMasked==MotionEvent.ACTION_HOVER_EXIT)0 else android.os.SystemClock.uptimeMillis()+4000;false}
        runCatching { window.addView(row,params);view=row;syncUnlock();render();handler.removeCallbacks(tick);handler.post(tick) }.onFailure { enabled=false;hide() }
    }
    private fun saveStyle(context: Context) {
        styleRevision=maxOf(styleRevision+1,android.os.SystemClock.elapsedRealtime())
        context.getSharedPreferences("bilimusic-lyrics-style",Context.MODE_PRIVATE).edit().putFloat("fontSize",fontSize).putBoolean("locked",locked).apply()
        owner?.notifyLyricsChanged()
    }
    private fun windowAlpha(context: Context): Float {
        val maximum=if(Build.VERSION.SDK_INT>=31)context.getSystemService(InputManager::class.java)?.maximumObscuringOpacityForTouch ?: .8f else 1f
        return FloatingLyricsWindowPolicy.alpha(locked,Build.VERSION.SDK_INT,maximum)
    }
    private fun applyLock(context: Context) {
        val params=layout ?: return
        params.flags=if(locked)params.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        params.alpha=windowAlpha(context)
        view?.let{runCatching{(context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).updateViewLayout(it,params)}}
        if(locked)controls?.visibility=View.GONE
        syncUnlock()
    }
    private fun controlButton(context: Context,icon: FloatingControlIcon.Kind,description: String,action:()->Unit)=ImageButton(context).apply {
        val padding=(11*context.resources.displayMetrics.density).toInt()
        setImageDrawable(FloatingControlIcon(icon));setPadding(padding,padding,padding,padding)
        background=android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed),GradientDrawable().apply{setColor(0x33FFFFFF);cornerRadius=8*context.resources.displayMetrics.density})
            addState(intArrayOf(),android.graphics.drawable.ColorDrawable(Color.TRANSPARENT))
        }
        contentDescription=description;setOnClickListener{action()}
    }
    private fun hideUnlock() {
        unlock?.let{button->owner?.let{context->runCatching{(context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(button)}}}
        unlock=null;unlockLayout=null
    }
    private fun syncUnlock() {
        val context=owner ?: return
        val row=view
        if(!enabled || !locked || row==null){hideUnlock();return}
        val params=layout ?: return
        val window=context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val density=context.resources.displayMetrics.density
        val size=(44*density).toInt();val gap=(6*density).toInt();val metrics=context.resources.displayMetrics
        val (x,y)=FloatingLyricsWindowPolicy.unlockPosition(params.x,params.y,row.width.takeIf{it>0} ?: params.width,row.height,metrics.widthPixels,metrics.heightPixels,size,gap)
        val existing=unlock
        if(existing!=null){unlockLayout?.let{if(it.x!=x || it.y!=y){it.x=x;it.y=y;runCatching{window.updateViewLayout(existing,it)}}};return}
        val button=controlButton(context,FloatingControlIcon.Kind.UNLOCK,"解锁悬浮歌词") {
            locked=false;controlsUntil=android.os.SystemClock.uptimeMillis()+4000;applyLock(context);saveStyle(context)
        }.apply{background=GradientDrawable().apply{setColor(0xAA516A80.toInt());cornerRadius=12*density}}
        val buttonParams=WindowManager.LayoutParams(size,size,WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,android.graphics.PixelFormat.TRANSLUCENT).apply{gravity=Gravity.TOP or Gravity.START;this.x=x;this.y=y}
        runCatching{window.addView(button,buttonParams);unlock=button;unlockLayout=buttonParams}.onFailure {
            // Never leave the user in a lock state with no usable unlock target.
            locked=false;applyLock(context);saveStyle(context)
        }
    }
    private fun render() {
        val service=owner ?: return
        val output=text ?: return
        val position=service.lyricPosition()
        if(data.optString("id")!=position.first) { output.showLyric(service.lyricTitle(),position.first);nextText?.showLyric(" ",position.first);return }
        val time=position.second*1000-data.optDouble("biasMs",0.0)
        val lines=data.optJSONArray("lines")
        var activeIndex=-1
        if(lines!=null)for(i in 0 until lines.length()){if((lines.optJSONObject(i)?.optDouble("timeMs",Double.MAX_VALUE) ?: Double.MAX_VALUE) > time)break;activeIndex=i}
        val current=activeIndex.coerceAtLeast(0)
        val other=if(current+1<(lines?.length() ?: 0))current+1 else current-1
        for(slot in 0..1) {
            val target=if(slot==0)output else nextText ?: continue
            val index=if(current%2==slot)current else other
            val line=if(index>=0)lines?.optJSONObject(index) else null
            val active=index==activeIndex && line!=null && (!data.optBoolean("subtitles") || !line.has("endTimeMs") || time<line.optDouble("endTimeMs"))
            target.setTextColor(if(active)activeColor else inactiveColor)
            val key="${position.first}:$index:${line?.optDouble("timeMs")}"
            if(line==null){target.showLyric(if(slot==0 && (lines?.length() ?: 0)==0)service.lyricTitle() else " ",key);continue}
            val words=line.optJSONArray("words")
            val scroll=lyricScrollProgress(line,time,lines?.optJSONObject(index+1)?.optDouble("timeMs"))
            if(!active || words==null || words.length()==0){target.showLyric(line.optString("text"),key,active,scroll);continue}
            val body=SpannableStringBuilder()
            for(i in 0 until words.length()) {
                val word=words.optJSONObject(i) ?: continue
                val start=body.length;body.append(word.optString("text"))
                val duration=word.optDouble("endTimeMs")-word.optDouble("startTimeMs")
                val progress=if(duration>0)((time-word.optDouble("startTimeMs"))/duration).coerceIn(0.0,1.0).toFloat() else 0f
                if(body.length>start)body.setSpan(WordProgress(progress,activeColor,inactiveColor),start,body.length,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            target.showLyric(body,key,active,scroll)
        }
    }

    private fun lyricScrollProgress(line: org.json.JSONObject,time: Double,next: Double?): Float {
        val words=line.optJSONArray("words")
        if(words!=null && words.length()>0) {
            var total=0
            for(i in 0 until words.length())total+=words.optJSONObject(i)?.optString("text")?.let{it.codePointCount(0,it.length)} ?: 0
            if(total==0)return 0f
            var completed=0.0
            for(i in 0 until words.length()) {
                val word=words.optJSONObject(i) ?: continue
                val value=word.optString("text");val size=value.codePointCount(0,value.length)
                val start=word.optDouble("startTimeMs");val end=word.optDouble("endTimeMs")
                if(time<start)return (completed/total).toFloat()
                if(time<end)return ((completed+size*((time-start)/(end-start).coerceAtLeast(1.0)).coerceIn(0.0,1.0))/total).toFloat()
                completed+=size
            }
            return 1f
        }
        val start=line.optDouble("timeMs")
        val value=line.optString("text")
        val end=if(line.has("endTimeMs"))line.optDouble("endTimeMs") else next ?: (start+maxOf(3000,value.codePointCount(0,value.length)*250))
        return ((time-start)/(end-start).coerceAtLeast(1.0)).coerceIn(0.0,1.0).toFloat()
    }

    private class WordProgress(val progress: Float,val active:Int,val inactive:Int): ReplacementSpan() {
        override fun getSize(paint:Paint,text:CharSequence,start:Int,end:Int,fm:Paint.FontMetricsInt?):Int { if(fm!=null)paint.getFontMetricsInt(fm);return kotlin.math.ceil(paint.measureText(text,start,end).toDouble()).toInt() }
        override fun draw(canvas:Canvas,text:CharSequence,start:Int,end:Int,x:Float,top:Int,y:Int,bottom:Int,paint:Paint) {
            val color=paint.color;paint.color=inactive;canvas.drawText(text,start,end,x,y.toFloat(),paint)
            val saved=canvas.save();canvas.clipRect(x,top.toFloat(),x+paint.measureText(text,start,end)*progress,bottom.toFloat());paint.color=active;canvas.drawText(text,start,end,x,y.toFloat(),paint);canvas.restoreToCount(saved);paint.color=color
        }
    }
}
