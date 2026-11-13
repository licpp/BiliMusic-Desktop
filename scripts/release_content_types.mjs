// APKs use a ZIP container but must be uploaded as Android install packages.
export function releaseContentType(name) {
  const extension=name.toLowerCase().split('.').pop();
  return ({apk:'application/vnd.android.package-archive',zip:'application/zip',json:'application/json',txt:'text/plain',md:'text/markdown'})[extension] || 'application/octet-stream';
}
export function inspectDownloadHeaders(file,headers) {
  const contentType=(headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const disposition=headers.get('content-disposition')||'';
  let filename;
  const encoded=disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  const plain=disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/i);
  if(encoded){try{filename=decodeURIComponent(encoded[1].trim())}catch{throw new Error('Invalid download filename encoding')}}
  else if(plain)filename=plain[1]??plain[2];
  let warning;
  if(file.toLowerCase().endsWith('.apk')) {
    if(filename && !filename.toLowerCase().endsWith('.apk'))throw new Error('APK download filename is not .apk: '+filename);
    if(['application/zip','application/x-zip','application/x-zip-compressed'].includes(contentType)){
      if(!filename)throw new Error('APK download is advertised as ZIP without an APK filename');
      warning='Provider advertises APK as ZIP; filename and package bytes must be verified';
    }
  }
  return {contentType,filename:filename||null,...(warning?{warning}:{})};
}
