(function(){
  function utf8ToBase64(str){
    var bytes = new TextEncoder().encode(str);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  function base64ToUtf8(b64){
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function BufferShim(str, encoding){
    this.str = str;
    this.encoding = encoding;
  }
  BufferShim.prototype.toString = function(targetEncoding){
    if (this.encoding === "base64" && targetEncoding === "utf-8") return base64ToUtf8(this.str);
    if (!this.encoding && targetEncoding === "base64") return utf8ToBase64(this.str);
    if (!this.encoding && (!targetEncoding || targetEncoding === "utf-8" || targetEncoding === "utf8")) return this.str;
    throw new Error("buffer-banner: unsupported conversion " + (this.encoding || "raw") + " -> " + (targetEncoding || "utf-8"));
  };
  BufferShim.from = function(input, encoding){ return new BufferShim(input, encoding); };
  if (typeof globalThis.Buffer === "undefined") {
    globalThis.Buffer = BufferShim;
  }
})();
