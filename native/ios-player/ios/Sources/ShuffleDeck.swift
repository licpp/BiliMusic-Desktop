import Foundation

// Pure queue policy; verify changes against src/domain/shuffle.ts with shared fixtures.
struct ShuffleItem { let id: String; var artist: String = ""; var bvid: String = "" }
final class ShuffleDeck {
    private var remaining: [String] = []
    private var played = Set<String>()
    private var history: [String] = []
    private var cursor = -1
    private var items: [ShuffleItem] = []
    private let random: () -> Double
    init(random: @escaping () -> Double = { Double.random(in: 0..<1) }) { self.random=random }
    func reset() { remaining=[];played=[];history=[];cursor = -1;items=[] }
    private func unit() -> Double { let n=random();return n.isFinite ? max(0,min(0.9999999999999999,n)) : 0 }
    private func artist(_ item: ShuffleItem?) -> String {
        let value=(item?.artist ?? "").trimmingCharacters(in:.whitespacesAndNewlines).lowercased()
        return value.range(of:"^(?:歌手未知|未知歌手|unknown(?: artist)?)$",options:.regularExpression) == nil ? value : ""
    }
    private func order(_ ids: [String], _ current: String) -> [String] {
        if ids.count<2 {return ids}
        let byId=Dictionary(uniqueKeysWithValues:items.map{($0.id,$0)})
        var recent: [String:Int] = [:]
        for (i,id) in history[max(0,cursor-49)..<(cursor+1)].enumerated(){recent[id]=i+1}
        var best: [String] = [];var bestScore=Double.infinity
        for _ in 0..<4 {
            var rows=ids
            for i in stride(from:rows.count-1,through:1,by:-1){let j=Int(unit()*Double(i+1));rows.swapAt(i,j)}
            if rows[0]==current,let i=rows.firstIndex(where:{$0 != current}),i>0 {rows.swapAt(0,i)}
            var score=0.0;var previous=byId[current];let prefix=min(rows.count,128)
            for i in 0..<prefix {
                let item=byId[rows[i]],weight=Double(prefix-i)
                score+=weight*Double(recent[rows[i]] ?? 0)*4
                if let bvid=item?.bvid,!bvid.isEmpty,bvid==previous?.bvid {score+=weight*240}
                let name=artist(item);if !name.isEmpty,name==artist(previous){score+=weight*100}
                previous=item
            }
            if score<bestScore {best=rows;bestScore=score}
        }
        return best
    }
    func observe(_ incoming:[ShuffleItem],_ current:String) {
        var seen=Set<String>();items=incoming.filter{!$0.id.isEmpty && seen.insert($0.id).inserted}
        let valid=Set(items.map{$0.id})
        let before=history.prefix(cursor+1).filter{valid.contains($0)}.count
        history=history.filter{valid.contains($0)};cursor=before-1
        played.formIntersection(valid)
        remaining=remaining.filter{valid.contains($0) && !played.contains($0)}
        let pending=Set(remaining);let added=items.filter{!played.contains($0.id) && !pending.contains($0.id)}.map{$0.id}
        let ordered=order(added,current)
        if remaining.isEmpty {remaining=ordered}else{for id in ordered{remaining.insert(id,at:Int(unit()*Double(remaining.count+1)))}}
        if valid.contains(current),(cursor<0 || history[cursor] != current) {
            history=Array(history.prefix(cursor+1));history.append(current);cursor=history.count-1
            played.insert(current);remaining.removeAll{$0==current};trimHistory()
        }
    }
    private func trimHistory(){if history.count>200{let extra=history.count-200;history=Array(history.dropFirst(extra));cursor-=extra}}
    func target(_ incoming:[ShuffleItem],_ current:String,_ direction:Int) -> String? {
        observe(incoming,current)
        if items.isEmpty{return nil}
        if direction<0{cursor=max(0,cursor-1);return history.indices.contains(cursor) ? history[cursor] : current}
        if cursor+1<history.count{cursor+=1;return history[cursor]}
        if remaining.isEmpty{played=[];remaining=order(items.map{$0.id},current)}
        guard !remaining.isEmpty else{return nil}
        let next=remaining.removeFirst();played.insert(next);history=Array(history.prefix(cursor+1));history.append(next);cursor=history.count-1;trimHistory()
        return next
    }
}
