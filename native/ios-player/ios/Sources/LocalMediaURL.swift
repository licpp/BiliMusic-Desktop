import Foundation

// Only the app's loopback media routes are accepted, including its virtual HLS index.
func validatedLocalMediaURL(_ value: String) -> URL? {
    guard let url=URL(string:value),url.scheme=="http",url.host=="127.0.0.1",
          let port=url.port,port>0,port<=65535,url.user==nil,url.password==nil,
          url.query==nil,url.fragment==nil else{return nil}
    let parts=url.path.split(separator:"/")
    guard parts.count==2 || parts.count==3 && parts[2]=="index.m3u8" else{return nil}
    return url
}
