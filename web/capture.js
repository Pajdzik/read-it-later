const origin = location.origin;
const link = document.querySelector("#bookmarklet");
const code = `javascript:(()=>{const u=location.href;const t=document.title;window.open(${JSON.stringify(origin + "/add?url=")}+encodeURIComponent(u)+"&title="+encodeURIComponent(t),"_blank","noopener")})()`;
link.href = code;
document.querySelector("#api-url").textContent = `${origin}/api/capture`;
