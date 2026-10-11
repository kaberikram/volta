// GLSL ported from the clip2_dots_v2 renderer (c3.html), generalised for any aspect / crop.
export const VS = `#version 300 es
precision highp float;
uniform sampler2D uR, uD; uniform mat4 uVP; uniform vec3 uEye, uPiv, uDot, uTint, uBg, uWave; uniform vec4 uCrop; uniform vec2 uRes, uCell0;
uniform float uPitch, uCols, uCat, uLayer, uInk, uSrc, uFull, uGrid, uSpark, uRmin, uGain, uInv, uSwell, uAlpha, uD0, uAsp, uDet, uHitZ, uFocus, uFovS, uFogN, uFogF, uPd, uOccA, uHalo, uT, uEchoZ, uLod;
out vec4 vCol; out float vR; out float vS; out float vSoft;
float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
void cull(){ gl_Position=vec4(9.,9.,9.,1.); gl_PointSize=0.; }
void main(){
  int id=gl_VertexID; float cx=float(id % int(uCols)), cy=float(id / int(uCols)); float fid=float(id);
  vec2 jit=uSpark>.5 ? (vec2(h1(fid*1.7),h1(fid*3.1))-.5)*1.1 : vec2(0.);
  vec2 px=(vec2(cx,cy)+uCell0+.5+jit)*uPitch; vec2 uv=px/uRes;
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
in vec2 v; uniform sampler2D uDots, uR, uBl; uniform vec3 uBg, uFlashCol; uniform vec4 uCrop; uniform float uMode, uFlash, uCA, uCon, uBloom, uFx; uniform vec2 uShake, uRes; out vec4 o;
vec3 rawAt(vec2 q){ return texture(uR,uCrop.xy+vec2(q.x,1.-q.y)*uCrop.zw).rgb; }
vec3 look(vec2 q){ if(uMode>.5) return rawAt(q); vec4 d=texture(uDots,q); return uBg*(1.-d.a)+d.rgb; }
void main(){ vec2 q=v+uShake; vec2 c=q-.5; vec2 ca=c*uCA/uRes.x*2.;
  vec3 col=vec3(look(q+ca).r, look(q).g, look(q-ca).b);
  if(uMode<.5) col+=texture(uBl,q).rgb*uBloom;
  col=clamp((col-.5)*uCon+.5,0.,1.);
  float vg=1.-dot(c,c)*.5; col*=vg;
  col=mix(col,uFlashCol,uFlash);
  col=mix(rawAt(v), col, uFx);
  o=vec4(col,1.); }`;

// ---------------------------------------------------------------- plates stage (HDR target, stage space: metres, y up, floor y=0)
const HDR = '#version 300 es\nprecision highp float;\n';
const STAGE_LIB = `
uniform vec3 uEye, uFogC; uniform float uFogD, uFogH;
float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
vec3 rotYv(vec3 v,float a){ float c=cos(a), s=sin(a); return vec3(v.x*c+v.z*s, v.y, -v.x*s+v.z*c); }
float fogAmt(vec3 P){ vec3 rd=P-uEye; float L=length(rd); rd/=max(L,1e-4); float b=1./uFogH, a0=uFogD*exp(-max(uEye.y,0.)*b), k=rd.y*b;
  float f=abs(k)>1e-4 ? a0*(1.-exp(-L*k))/k : a0*L; return 1.-exp(-max(f,0.)); }
vec3 fogApply(vec3 c, vec3 P){ return mix(c, uFogC, fogAmt(P)); }
`;
const SPOTS = `uniform vec3 uSpotP[5], uSpotD[5], uSpotC[5]; uniform float uSpotCos[5];
float spotK(int i, vec3 P){ vec3 L=normalize(P-uSpotP[i]); return smoothstep(uSpotCos[i], mix(uSpotCos[i],1.,.35), dot(L,uSpotD[i])); }`;
export const stageSrc = body => HDR + STAGE_LIB + body;

export const SKY_FS = stageSrc(SPOTS + `
in vec2 v; out vec4 o; uniform vec3 uFw, uRt, uUp, uSky, uSky2; uniform float uTanF, uAsp, uHaze;
void main(){ vec2 p=v*2.-1.; vec3 rd=normalize(uFw+p.x*uTanF*uAsp*uRt+p.y*uTanF*uUp);
  vec3 col=mix(uSky, uSky2, smoothstep(-.05,.6,rd.y));
  col+=uFogC*uHaze*exp(-abs(rd.y)*5.);
  for(int i=0;i<5;i++){ vec3 d=normalize(uSpotP[i]-uEye); float c=max(dot(rd,d),0.); col+=uSpotC[i]*(pow(c,3000.)*4.+pow(c,80.)*.18); }
  o=vec4(col,1.); }`);

export const FLOOR_VS = stageSrc(`
uniform mat4 uVP; out vec3 vP;
void main(){ vec2 c=vec2((gl_VertexID&1)==1?1.:-1., (gl_VertexID&2)==2?1.:-1.)*30.; vP=vec3(c.x,0.,c.y); gl_Position=uVP*vec4(vP,1.); }`);
export const FLOOR_FS = stageSrc(SPOTS + `
in vec3 vP; out vec4 o;
uniform vec3 uGridC, uRedC, uDancer; uniform float uGridK, uRedGrid, uTheta, uKick, uRing, uNSh, uRefl; uniform vec4 uWaves; uniform vec4 uSh[16];
float grid(vec2 p, float cell, out float glow){ vec2 q=p/cell, fw=fwidth(q), g=abs(fract(q-.5)-.5);
  vec2 l=1.-smoothstep(fw*.5, fw*1.6, g); float fade=1.-smoothstep(.12,.45,max(fw.x,fw.y));
  glow=exp(-min(g.x,g.y)*cell*9.)*fade; return max(l.x,l.y)*fade; }
void main(){
  vec3 V=normalize(uEye-vP); float tile=h1(dot(floor(vP.xz),vec2(17.13,3.71)));
  vec3 base=vec3(.010,.013,.015)*(.75+.5*tile);
  float g1, g4; float l1=grid(vP.xz,1.,g1), l4=grid(vP.xz,4.,g4);
  vec3 em=uGridC*(l1*.55+g1*.07)*uGridK;
  em=mix(em, uRedC*(l4*1.1+g4*.18)*uGridK, uRedGrid*max(l4, g4*.5));
  float rr=length(vP.xz), an=atan(vP.x,vP.z)-uTheta;
  em+=uRedC*(exp(-abs(rr-4.6)*55.)*smoothstep(.1,.6,sin(an+.5)) + exp(-abs(rr-6.2)*55.)*smoothstep(0.,.5,sin(-2.*an+1.3)))*(1.1+1.6*uKick);
  float dd=length(vP.xz-uDancer.xz);
  em+=vec3(.86,.98,1.)*exp(-abs(dd-.62)*38.)*uRing*1.4;
  em+=vec3(.75,.95,1.)*exp(-abs(dd-uWaves.x)*7.)*uWaves.y + uRedC*exp(-abs(dd-uWaves.z)*5.)*uWaves.w;
  vec3 lit=vec3(0); for(int i=0;i<5;i++) lit+=uSpotC[i]*spotK(i,vP);
  float sh=1.; for(int i=0;i<16;i++){ if(float(i)>=uNSh) break; vec2 d=vP.xz-uSh[i].xy; sh*=1.-uSh[i].w*exp(-dot(d,d)/(uSh[i].z*uSh[i].z)); }
  float fa=fogAmt(vP);
  vec3 surf=mix((base+lit*.22)*sh, uFogC, fa), emf=em*sh*(1.-fa*.85);
  float Fr=mix(.12,.8,pow(1.-abs(V.y),3.)), a=1.-clamp(Fr*(.85+.3*tile)*uRefl,0.,.95);
  o=vec4(surf*a+emf, a); }`);

export const SLAB_VS = stageSrc(`
layout(location=0) in vec2 aV; layout(location=1) in vec4 aA; layout(location=2) in vec4 aB;
uniform mat4 uVP; uniform vec3 uGPos; uniform float uGYaw, uAge, uColl, uSxz, uN, uRh, uSeed, uMirror, uTwist, uT, uStyle;
out vec3 vW, vN; out float vJ;
float spow(float x,float e){ return sign(x)*pow(abs(x),e); }
void main(){
  float th=aV.x, ring=aV.y, a=aB.x, b=aB.y, t=aB.z, rnd=fract(aB.w+uSeed), jN=aA.w;
  float jy=(rnd-.5)*(uStyle>1.5?.21:uStyle<.5?.07:.1);
  a*=1.+(fract(rnd*7.13)-.5)*(uStyle>1.5?.12:.04); b*=1.+(fract(rnd*3.71)-.5)*.12;
  vec2 jo=uStyle>1.5?(vec2(fract(rnd*11.3),fract(rnd*5.9))-.5)*.024:vec2(0.);
  float bj=clamp((uAge-.10*jN)/.06,0.,1.), bm=bj-1., bo=1.+2.7*bm*bm*bm+1.7*bm*bm;
  float cc=clamp((uColl*.6-.5*(1.-jN))/.12,0.,1.);
  float sxz=max(bo,0.)*(1.-cc*cc)*uSxz;
  float e=2./uN, c=cos(th), s=sin(th);
  vec2 se=vec2(spow(c,e),spow(s,e)), nn=normalize(vec2(spow(c,2.-e)/max(a,1e-3), spow(s,2.-e)/max(b,1e-3)));
  float ty=t*.5, rr=uRh*ty; vec3 p, n;
  if(ring<-.5){ p=vec3(0.,-ty,0.); n=vec3(0.,-1.,0.); }
  else if(ring>4.5){ p=vec3(0.,ty,0.); n=vec3(0.,1.,0.); }
  else { float ph=radians(-90.+45.*ring); vec2 inner=se*vec2(max(a-rr,.004),max(b-rr,.004));
    p=vec3(inner.x+nn.x*rr*cos(ph), ty*sin(ph), inner.y+nn.y*rr*cos(ph));
    n=normalize(vec3(nn.x*cos(ph)*ty, sin(ph)*max(rr,1e-3), nn.y*cos(ph)*ty)); }
  p.xz*=sxz;
  float yw=jy+uTwist*sin(.9*uT+jN*9.+uSeed*6.283);
  p=rotYv(p,yw); n=rotYv(n,yw);
  vec3 c0=aA.xyz+vec3(jo.x,0.,jo.y), Wc=uGPos+rotYv(c0,uGYaw), W=uGPos+rotYv(c0+p,uGYaw);
  W=Wc+(W-Wc)*smoothstep(.6,1.6,length(Wc-uEye));
  vW=W; vN=rotYv(n,uGYaw); vJ=jN;
  if(uMirror>.5) W.y=-W.y;
  gl_Position=uVP*vec4(W,1.); }`);
export const SLAB_FS = stageSrc(SPOTS + `
in vec3 vW, vN; in float vJ; out vec4 o;
uniform vec3 uAlb, uEmi, uSpec, uRimC, uKeyC, uRedC; uniform float uGloss, uRimK, uMetal, uE, uDark, uAdd, uBody, uMirror, uLaser, uNewest, uT;
void main(){
  vec3 N=normalize(vN), V=normalize(uEye-vW); if(dot(N,V)<0.) N=-N;
  float F=pow(1.-max(dot(N,V),0.),3.);
  vec3 col=uAlb*(uKeyC*(dot(N,normalize(vec3(.2,1.,.3)))*.5+.5)*.8+.1);
  col+=uSpec*pow(max(N.y,0.),6.)*.18;
  for(int i=0;i<5;i++){ vec3 L=uSpotP[i]-vW; L=normalize(L); float k=spotK(i,vW); if(k<=0.) continue;
    vec3 H=normalize(L+V); float sp=pow(max(dot(N,H),0.),uGloss)*(uGloss+8.)/25.;
    col+=uSpotC[i]*k*(uAlb*max(dot(N,L)*.6+.4,0.)+uSpec*sp*mix(.45,1.,uMetal)); }
  col+=uRimC*F*uRimK;
  col+=uRedC*max(-N.y,0.)*.18*uLaser;
  vec3 R=reflect(-V,N); col+=uSpec*pow(abs(sin(atan(R.x,R.z)*24.)),40.)*smoothstep(-.1,.3,R.y)*uMetal*.5;
  col*=mix(.4,1.,smoothstep(-.6,.4,N.y))*uDark;
  col+=uEmi*uE*(.35+.65*F);
  col+=uEmi*uNewest*smoothstep(.93,1.,fract(vW.y*5.-uT*1.7))*.8;
  float mk=uMirror>.5?.35*exp(-1.5*vW.y):1.;
  vec3 Pf=uMirror>.5?vec3(vW.x,-vW.y,vW.z):vW;
  if(uAdd>.5){ vec3 g=(uEmi+uAlb*.35)*(uBody+1.4*F)*uE*(1.-fogAmt(Pf)); o=vec4(g*mk,0.); return; }
  o=vec4(fogApply(col,Pf)*mk,1.); }`);

export const BEAM_VS = stageSrc(`
layout(location=0) in vec4 iA; layout(location=1) in vec4 iB; layout(location=2) in vec4 iC; layout(location=3) in vec4 iK;
uniform mat4 uVP; uniform float uPxK, uMirror; uniform vec3 uCamR, uCamU;
out vec2 vUV; out vec3 vCol; out float vI, vKind, vFog;
void main(){
  int id=gl_VertexID; float t=float(id>>1), sd=float(id&1)*2.-1., kind=iK.x, I=iC.w; vec3 P;
  if(kind>3.5){ vec2 c=vec2(sd, t*2.-1.); P=iA.xyz+(uCamR*c.x+uCamU*c.y)*iA.w; vUV=c; }
  else { P=mix(iA.xyz,iB.xyz,t); float w=mix(iA.w,iB.w,t); vec3 dir=iB.xyz-iA.xyz, toE=uEye-P, sv=cross(dir,toE);
    float L=length(sv), ld=length(dir)*length(toE); sv=L>1e-5*ld?sv/L:uCamR;
    if(kind>1.5&&kind<2.5) I*=smoothstep(.15,.5,L/max(ld,1e-6));
    float w2=max(w,1.4*uPxK*length(toE)); I*=w/w2; P+=sv*w2*sd; vUV=vec2(sd,t); }
  vCol=iC.rgb; vI=I; vKind=kind; vFog=1.-.8*fogAmt(P);
  if(uMirror>.5) P.y=-P.y;
  gl_Position=uVP*vec4(P,1.); }`);
export const BEAM_FS = stageSrc(`
in vec2 vUV; in vec3 vCol; in float vI, vKind, vFog; out vec4 o; uniform float uMirK;
void main(){ float u=vUV.x, pr;
  if(vKind<.5||(vKind>2.5&&vKind<3.5)) pr=exp(-40.*u*u)+.25*exp(-4.*u*u);
  else if(vKind<1.5) pr=(1.-smoothstep(.22,.34,abs(u)))+.35*exp(-abs(u)*4.);
  else if(vKind<2.5) pr=pow(max(1.-u*u,0.),2.)*exp(-1.2*vUV.y)*(.8+.2*h1(floor(gl_FragCoord.y*.5)+floor(gl_FragCoord.x*.5)*7.));
  else { float r=length(vUV); pr=(exp(-9.*r)+.35*pow(abs(cos(2.*atan(vUV.y,vUV.x))),40.)*exp(-3.*r))*(1.-smoothstep(.8,1.,r)); }
  o=vec4(vCol*vI*pr*vFog*uMirK,0.); }`);

export const BRIGHT_HDR = `#version 300 es
precision highp float; in vec2 v; uniform sampler2D uT; uniform vec2 uPx, uTh; out vec4 o;
void main(){ vec3 c=(texture(uT,v+uPx*vec2(-1,-1)).rgb+texture(uT,v+uPx*vec2(1,-1)).rgb+texture(uT,v+uPx*vec2(-1,1)).rgb+texture(uT,v+uPx*vec2(1,1)).rgb)*.25;
  float l=max(max(c.r,c.g),c.b); o=vec4(min(c,vec3(16.))*smoothstep(uTh.x,uTh.y,l),1.); }`;
export const COMP_HDR = `#version 300 es
precision highp float;
in vec2 v; uniform sampler2D uDots, uR, uBl; uniform vec3 uFlashCol; uniform vec4 uCrop; uniform float uFlash, uCA, uCon, uBloom, uFx, uExp, uN, uTone; uniform vec2 uShake, uRes, uBlurV; out vec4 o;
vec3 rawAt(vec2 q){ return texture(uR,uCrop.xy+vec2(q.x,1.-q.y)*uCrop.zw).rgb; }
vec3 look(vec2 q){ if(dot(uBlurV,uBlurV)<1e-8) return texture(uDots,q).rgb; vec3 c=vec3(0); for(int i=0;i<8;i++) c+=texture(uDots,q+uBlurV*(float(i)/7.-.5)).rgb; return c*.125; }
vec3 tm(vec3 c){ vec3 hi=.72+.28*(1.-exp(-(max(c,vec3(.72))-.72)/.28)); return mix(c,hi,step(vec3(.72),c)); }
void main(){ vec2 q=v+uShake; vec2 c=q-.5; vec2 ca=c*uCA/uRes.x*2.;
  vec3 col=vec3(look(q+ca).r, look(q).g, look(q-ca).b);
  col+=texture(uBl,q).rgb*uBloom;
  col*=uExp; if(uTone>.5) col=tm(col);
  col=clamp((col-.5)*uCon+.5,0.,1.);
  float vg=1.-dot(c,c)*.6; col*=vg;
  col=mix(col,uFlashCol,uFlash);
  col+=(fract(sin(dot(gl_FragCoord.xy+uN*7.13,vec2(12.9898,78.233)))*43758.5453)-.5)*.02;
  col=mix(rawAt(v), col, uFx);
  o=vec4(col,1.); }`;
