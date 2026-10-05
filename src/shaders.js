// GLSL ported from the clip2_dots_v2 renderer (c3.html), generalised for any aspect / crop.
export const VS = `#version 300 es
precision highp float;
uniform sampler2D uR, uD; uniform mat4 uVP; uniform vec3 uEye, uPiv, uDot, uTint, uBg, uWave; uniform vec4 uCrop; uniform vec2 uRes;
uniform float uPitch, uCols, uCat, uLayer, uInk, uSrc, uFull, uGrid, uSpark, uRmin, uGain, uInv, uSwell, uAlpha, uD0, uAsp, uDet, uHitZ, uFocus, uFovS, uFogN, uFogF, uPd, uOccA, uHalo, uT, uEchoZ, uLod;
out vec4 vCol; out float vR; out float vS; out float vSoft;
float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
void cull(){ gl_Position=vec4(9.,9.,9.,1.); gl_PointSize=0.; }
void main(){
  int id=gl_VertexID; float cx=float(id % int(uCols)), cy=float(id / int(uCols)); float fid=float(id);
  vec2 jit=uSpark>.5 ? (vec2(h1(fid*1.7),h1(fid*3.1))-.5)*1.1 : vec2(0.);
  vec2 px=(vec2(cx,cy)+.5+jit)*uPitch; vec2 uv=px/uRes;
  if(uv.x>1.||uv.y>1.){ cull(); return; }
  vec2 suv=uCrop.xy+uv*uCrop.zw;
  vec3 C=textureLod(uR,suv,uLod).rgb; vec4 D=texture(uD,suv);
  float dep=D.r, person=smoothstep(.3,.7,D.g);
  float occ=smoothstep(uPd+.1,uPd+.22,dep)*(1.-person)*(1.-smoothstep(.78,.92,suv.y));
  float cat= person>.5 ? 2. : (occ>.5 ? 3. : 0.);
  if(uCat>.5&&uCat<1.5){ if(cat!=2.){ cull(); return; } } else if(cat!=uCat){ cull(); return; }
  float lum=dot(C,vec3(.299,.587,.114));
  float tone=clamp(pow(clamp(lum*1.2*uGain+.03,0.,1.),.85),0.,1.);
  if(uInk>.5) tone=clamp(1.-lum*.85,0.,1.);
  vec3 src=clamp(max(mix(vec3(lum),C,1.45),0.)*1.2*uGain,0.,1.); if(uInv>.5) src=1.-src;
  float r, a=1.; vec3 col;
  float ps=uPitch;
  if(uFull>.5){ r=ps*.5*mix(uRmin,1.04,tone); col=src; }
  else if(uSpark>.5){ float on=step(h1(fid*.37),cat==2.?.42:cat==3.?(uOccA<.5?.35:.12):(uOccA<.5?.2:.06)); r=on*mix(1.4,4.6,pow(h1(fid*5.3),2.))*(.8+.5*tone)*min(uRes.x,uRes.y)/1080.; col=uDot; a=cat==3.?(uOccA<.5?2.4:.5):cat==0.?(uOccA<.5?.8:.45):1.; }
  else { r=ps*.5*(cat==2.?mix(.14,1.1,tone):cat==3.?mix(.25,.85,tone):mix(.14,.42,tone)*uGrid);
    col=(uSrc>.5)?src:(cat==3.&&uInk<.5?mix(uBg,uDot,.45):uDot); a=cat==2.?1.:cat==3.?(uInk>.5?.6:.85):.4; }
  if(cat==3.) a*=uOccA;
  if(uCat==1.){ r*=1.-.17*uLayer; a*=.75-.15*uLayer; col=mix(col,uBg,.18*uLayer); }
  col*=uTint; r*=uSwell;
  vec2 ndc=vec2(uv.x*2.-1.,1.-uv.y*2.);
  float dist=uD0*(2.4-1.8*dep); if(cat==3.) dist*=.72; if(uCat==1.) dist+=uLayer*uD0*.075; dist+=uEchoZ*uD0;
  vec3 Pp=vec3(ndc.x*uAsp,ndc.y,-uD0)*(dist/uD0);
  float rr=h1(fid*1.3), r2=h1(fid*2.7+1.), r3=h1(fid*.7+4.);
  Pp+=vec3(sin(uT*1.3+fid*.11),cos(uT*1.1+fid*.07),sin(uT*.9+fid*.05))*.012*(cat==2.?.4:1.);
  vec3 toE=normalize(uEye-Pp);
  Pp+=toE*uHitZ*uD0*(cat==2.?.16:.09);
  float boost=0.;
  if(uWave.z>0.){ float dd=length((Pp.xy-uPiv.xy)); float w=exp(-pow((dd-uWave.x)/(.09+.12*uWave.x),2.))*uWave.z; Pp+=toE*w*uD0*.22; boost+=w; }
  if(uDet>0.){ vec3 dv=Pp-uPiv; vec3 dir=normalize(dv+(vec3(rr,r3,r2)-.5)*.9);
    Pp+=dir*uDet*(.4+1.8*rr)*uD0*.8 + vec3(0,0,1.)*uDet*(.3+1.4*r2)*uD0; boost+=uDet*(1.+3.*r2*r2); a*=1.-.15*uDet; }
  vec4 cp=uVP*vec4(Pp,1.);
  if(cp.w<.04){ cull(); return; }
  float sz=dist/cp.w*uFovS;
  float coc=abs(cp.w-uFocus)/cp.w, blur=clamp(coc*1.6,0.,1.);
  float R=step(.05,r)*(r*sz*(1.+boost*.8)+coc*ps*.9);
  a*=mix(1.,.5,blur)*smoothstep(.04,.25,cp.w);
  float fg=smoothstep(uFogN,uFogF,cp.w); col=mix(col,uBg,fg*.75);
  col=mix(col,vec3(1.),clamp(boost*.35,0.,.6));
  R*=1.+uHalo*1.3;
  gl_Position=cp; gl_PointSize=min(R*2.+2.,700.);
  vR=R; vS=gl_PointSize; vSoft=max(blur,uHalo); vCol=vec4(col,a*uAlpha*step(.3,R)*(uHalo>0.?.07:1.));
}`;
export const FS = `#version 300 es
precision highp float;
in vec4 vCol; in float vR; in float vS; in float vSoft; out vec4 o;
void main(){ float d=length(gl_PointCoord-.5)*vS;
  float hard=clamp(vR-d+.5,0.,1.), soft=clamp(1.-d/vR,0.,1.); soft*=soft*(3.-2.*soft);
  float a=mix(hard,soft,vSoft)*vCol.a; if(a<=0.) discard; o=vec4(vCol.rgb*a,a); }`;
export const QV = `#version 300 es
out vec2 v; void main(){ vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); v=p; gl_Position=vec4(p*2.-1.,0.,1.); }`;
export const BRIGHT = `#version 300 es
precision highp float; in vec2 v; uniform sampler2D uT; out vec4 o;
void main(){ vec3 c=texture(uT,v).rgb; float l=max(max(c.r,c.g),c.b); o=vec4(c*smoothstep(.55,1.,l),1.); }`;
export const BLUR = `#version 300 es
precision highp float; in vec2 v; uniform sampler2D uT; uniform vec2 uDir; out vec4 o;
void main(){ vec3 s=vec3(0); float w[5]=float[](.227,.194,.121,.054,.016);
  s+=texture(uT,v).rgb*w[0]; for(int i=1;i<5;i++){ s+=texture(uT,v+uDir*float(i)).rgb*w[i]; s+=texture(uT,v-uDir*float(i)).rgb*w[i]; } o=vec4(s,1.); }`;
export const COMP = `#version 300 es
precision highp float;
in vec2 v; uniform sampler2D uDots, uR, uBl; uniform vec3 uBg, uFlashCol; uniform vec4 uCrop; uniform float uMode, uFlash, uCA, uCon, uBloom; uniform vec2 uShake, uRes; out vec4 o;
vec3 look(vec2 q){ if(uMode>.5) return texture(uR,uCrop.xy+vec2(q.x,1.-q.y)*uCrop.zw).rgb; vec4 d=texture(uDots,q); return uBg*(1.-d.a)+d.rgb; }
void main(){ vec2 q=v+uShake; vec2 c=q-.5; vec2 ca=c*uCA/uRes.x*2.;
  vec3 col=vec3(look(q+ca).r, look(q).g, look(q-ca).b);
  if(uMode<.5) col+=texture(uBl,q).rgb*uBloom;
  col=clamp((col-.5)*uCon+.5,0.,1.);
  float vg=1.-dot(c,c)*.5; col*=vg;
  col=mix(col,uFlashCol,uFlash); o=vec4(col,1.); }`;
