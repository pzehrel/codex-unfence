// ADR 0003 binds this approval to these bytes. Identity does not prove JavaScript
// glue or resource semantics. This registry has no runtime extension mechanism.
export const dependencyContracts = Object.freeze([
  Object.freeze({
    id: 'zxing-reader-lifetime-noninterference',
    revision: 1,
    size: 1_065_866,
    sha256: '0e8d688d71932ebb6b8b33f700d43d3cb997f59ed9cab3c05102d7f10288a392',
    binaryVersion: 1,
    relativePath: './zxing_reader.wasm',
    // Inertly decoded import names and function signatures for the approved bytes.
    // i/j/f/d denote i32/i64/f32/f64; this metadata grants no semantic trust.
    imports: 'a.a:>i a.b:ii>i a.c:iii>i a.d:i> a.e:iii> a.f:i> a.g:iiii> a.h:iiii>i a.i:i>i a.j:iiiii>i a.k:iiiii> a.l:ii> a.m:ii>i a.n:iiiiiiiiiii> a.o:iiiiii> a.p:iii> a.q:i>i a.r:iiiiii>i a.s:i>i a.t:iiiiiii>i a.u:iii> a.v:iiiiiiii> a.w:iiiiiiiiii> a.x:> a.y:iiiiiii> a.z:i>i a.A:iiiii> a.B:iiiidd>d a.C:iidi>i a.D:iiiiiiiii>i a.E:iiiiiiiii> a.F:i>i a.G:iiiiiiii>i a.H:iiiiiiiiii> a.I:iiiiii> a.J:iiiiiiiiiiiiiiii> a.K:iiiiiiiiiiii>i a.L:iiiiddi> a.M:iiii>d a.N:iiiii>d a.O:iii>i a.P:iiiiii>d a.Q:iiidd>i a.R:iiiiiid>i a.S:> a.T:iii> a.U:i> a.V:iiii>f a.W:iiiddddii> a.X:iii> a.Y:iiiiiiii> a.Z:iiiii>i a._:iiiiiii>i a.$:iiiiiiiiiiiiiiiiiiii> a.aa:iiiiiii> a.ba:> a.ca:iiii> a.da:ii>i a.ea:ii>i a.fa:>i a.ga:i>i a.ha:i> a.ia:iif>i a.ja:iiiiifff> a.ka:iii>d a.la:iiiiiiiiiiiiiiiii> a.ma:i> a.na:ii> a.oa:iiii> a.pa:ii> a.qa:iiii> a.ra:iiiiii> a.sa:iiiiiiiiiiiii> a.ta:ii> a.ua:i> a.va:iiiiiiiiii> a.wa:i>',
  }),
]);
