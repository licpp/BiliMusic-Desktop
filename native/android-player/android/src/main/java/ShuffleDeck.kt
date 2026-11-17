package app.bilimusic.player

/** Pure queue policy; keep behavior aligned with src/domain/shuffle.ts and shared fixtures. */
internal data class ShuffleItem(val id: String, val artist: String = "", val bvid: String = "")
internal class ShuffleDeck(private val random: () -> Double = { kotlin.random.Random.nextDouble() }) {
    private var remaining = mutableListOf<String>()
    private var played = mutableSetOf<String>()
    private var history = mutableListOf<String>()
    private var cursor = -1
    private var items = emptyList<ShuffleItem>()
    fun reset() { remaining.clear(); played.clear(); history.clear(); cursor=-1; items=emptyList() }
    private fun unit(): Double { val n=random(); return if(n.isFinite()) n.coerceIn(0.0,0.9999999999999999) else 0.0 }
    private fun artist(item: ShuffleItem?): String {
        val value=item?.artist?.trim()?.lowercase() ?: ""
        return if(Regex("^(?:歌手未知|未知歌手|unknown(?: artist)?)$").matches(value)) "" else value
    }
    private fun order(ids: List<String>, current: String): MutableList<String> {
        if(ids.size<2) return ids.toMutableList()
        val byId=items.associateBy { it.id }; val recent=mutableMapOf<String,Int>()
        history.subList(maxOf(0,cursor-49),cursor+1).forEachIndexed { i,id -> recent[id]=i+1 }
        var best=mutableListOf<String>(); var bestScore=Double.POSITIVE_INFINITY
        repeat(4) {
            val rows=ids.toMutableList()
            for(i in rows.lastIndex downTo 1) { val j=(unit()*(i+1)).toInt(); val old=rows[i]; rows[i]=rows[j]; rows[j]=old }
            if(rows[0]==current) { val i=rows.indexOfFirst { it!=current }; if(i>0){ rows[0]=rows[i]; rows[i]=current } }
            var score=0.0; var previous=byId[current]; val prefix=minOf(rows.size,128)
            for(i in 0 until prefix) {
                val item=byId[rows[i]]; val weight=prefix-i
                score+=weight*(recent[rows[i]] ?: 0)*4
                if(!item?.bvid.isNullOrEmpty() && item?.bvid==previous?.bvid) score+=weight*240
                val artist=artist(item); if(artist.isNotEmpty() && artist==artist(previous))score+=weight*100
                previous=item
            }
            if(score<bestScore){best=rows;bestScore=score}
        }
        return best
    }
    fun observe(incoming: List<ShuffleItem>, current: String) {
        items=incoming.filter { it.id.isNotEmpty() }.distinctBy { it.id }
        val valid=items.map { it.id }.toSet()
        val before=history.take(cursor+1).count { it in valid }
        history=history.filter { it in valid }.toMutableList();cursor=before-1
        played.retainAll(valid)
        remaining=remaining.filter { it in valid && it !in played }.toMutableList()
        val pending=remaining.toSet(); val added=items.filter { it.id !in played && it.id !in pending }.map { it.id }
        val ordered=order(added,current)
        if(remaining.isEmpty())remaining=ordered else for(id in ordered)remaining.add((unit()*(remaining.size+1)).toInt(),id)
        if(current in valid && history.getOrNull(cursor)!=current) {
            history=history.take(cursor+1).toMutableList();history.add(current);cursor=history.lastIndex
            played.add(current);remaining.removeAll { it==current };trimHistory()
        }
    }
    private fun trimHistory(){if(history.size>200){val extra=history.size-200;history=history.drop(extra).toMutableList();cursor-=extra}}
    fun target(incoming: List<ShuffleItem>,current:String,direction:Int):String? {
        observe(incoming,current)
        if(items.isEmpty())return null
        if(direction<0){cursor=maxOf(0,cursor-1);return history.getOrNull(cursor) ?: current}
        if(cursor+1<history.size){cursor++;return history[cursor]}
        if(remaining.isEmpty()){played.clear();remaining=order(items.map{it.id},current)}
        if(remaining.isEmpty())return null
        val next=remaining.removeAt(0);played.add(next);history=history.take(cursor+1).toMutableList();history.add(next);cursor=history.lastIndex;trimHistory()
        return next
    }
}
