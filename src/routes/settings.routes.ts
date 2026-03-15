'use client';
import { useState, useEffect, useCallback } from 'react';

const C = {
  bg:'#070D18', s2:'#0E1420', s3:'#131B2A', s4:'#1A2438',
  border:'#1E2D45', borderL:'#253650',
  white:'#E8EDF8', gray:'#7A8BA0', grayd:'#2E445E', graydd:'#1A2738',
  red:'#E01E2C', redD:'rgba(224,30,44,0.08)', redB:'rgba(224,30,44,0.18)',
  green:'#00D97E', greenD:'rgba(0,217,126,0.08)',
  blue:'#3E9EFF', blueD:'rgba(62,158,255,0.10)',
  yellow:'#FFB800', yellowD:'rgba(255,184,0,0.08)',
  purple:'#9B6EFF', purpleD:'rgba(155,110,255,0.08)',
  teal:'#00C9B1', orange:'#FF7A30',
};

/* ── Types ── */
interface City    { id: string; name: string; state?: string; is_active: boolean; created_at?: string; }
interface User    { id: string; name: string; mobile?: string; email?: string; role: string; employee_id?: string; city?: string; is_active: boolean; joined_date?: string; }
interface Setting { key: string; value: any; }

const API   = process.env.NEXT_PUBLIC_API_URL ?? '';
const token = () => (typeof window !== 'undefined' ? localStorage.getItem('kinematic_token') ?? '' : '');
const hdrs  = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` });

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return (j?.data ?? j) as T;
}
async function post<T>(path: string, body: any): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return (j?.data ?? j) as T;
}
async function patch<T>(path: string, body: any): Promise<T> {
  const r = await fetch(`${API}${path}`, { method: 'PATCH', headers: hdrs(), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}`);
  const j = await r.json();
  return (j?.data ?? j) as T;
}
async function del(path: string) {
  const r = await fetch(`${API}${path}`, { method: 'DELETE', headers: hdrs() });
  if (!r.ok) throw new Error(`${r.status}`);
}

/* ── Atoms ── */
const Spin = () => <div style={{ width:16, height:16, border:`2px solid ${C.border}`, borderTopColor:C.blue, borderRadius:'50%', animation:'sspin .6s linear infinite', flexShrink:0 }}/>;

const Tog = ({ val, onChange }: { val: boolean; onChange: (v: boolean) => void }) => (
  <div onClick={() => onChange(!val)} style={{ width:42, height:24, borderRadius:12, background:val?C.red:C.grayd, cursor:'pointer', position:'relative', transition:'background .2s', flexShrink:0 }}>
    <div style={{ position:'absolute', top:3, left:val?21:3, width:18, height:18, borderRadius:'50%', background:'#fff', transition:'left .2s', boxShadow:'0 1px 4px rgba(0,0,0,.4)' }}/>
  </div>
);

const Tag = ({ label, color }: { label: string; color: string }) => (
  <span style={{ display:'inline-flex', alignItems:'center', padding:'2px 8px', borderRadius:20, background:`${color}18`, color, fontSize:11, fontWeight:700 }}>{label}</span>
);

const inp: React.CSSProperties = {
  background:C.s3, border:`1.5px solid ${C.border}`, color:C.white,
  borderRadius:10, padding:'9px 13px', fontSize:13, fontFamily:"'DM Sans',sans-serif",
  outline:'none', width:'100%', colorScheme:'dark' as any,
};

const SaveBar = ({ saving, saved, onSave }: { saving:boolean; saved:boolean; onSave:()=>void }) => (
  <div style={{ display:'flex', justifyContent:'flex-end', marginTop:24 }}>
    <button onClick={onSave} disabled={saving}
      style={{ padding:'10px 24px', background:C.red, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:8, opacity:saving?0.6:1, fontFamily:"'DM Sans',sans-serif", boxShadow:`0 4px 16px ${C.redB}` }}>
      {saving ? <><Spin/>Saving…</> : saved ? '✓ Saved' : 'Save Changes'}
    </button>
  </div>
);

/* ══ SECTION: Geofence ══ */
function GeofenceSection() {
  const [cfg, setCfg]   = useState({ radius_meters:100, strict_mode:true, allow_override:false });
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<any>('/api/v1/settings/geofence').then(d => {
      if (d) setCfg(d);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try { await post('/api/v1/settings/geofence', cfg); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    catch {}
    setSaving(false);
  };

  const radii = [50, 100, 150, 200, 300, 500];

  return (
    <div>
      <SectionHeader icon="📍" title="Geo-fence Settings" desc="Configure the location boundary radius for check-ins across all meeting points"/>
      {loading ? <div style={{ padding:'32px', display:'flex', justifyContent:'center' }}><Spin/></div> : (
        <>
          <div style={{ display:'grid', gap:16 }}>
            {/* Radius */}
            <div style={{ background:C.s3, borderRadius:14, padding:20, border:`1px solid ${C.border}` }}>
              <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:4 }}>Check-in Radius</div>
              <div style={{ fontSize:12, color:C.gray, marginBottom:16 }}>FEs must be within this distance of the meeting point to check in</div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {radii.map(r => (
                  <button key={r} onClick={() => setCfg(p => ({...p, radius_meters:r}))}
                    style={{ padding:'8px 18px', borderRadius:8, border:`1.5px solid ${cfg.radius_meters===r?C.red:C.border}`, background:cfg.radius_meters===r?C.redD:C.s4, color:cfg.radius_meters===r?C.red:C.gray, fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif", transition:'all .15s' }}>
                    {r}m
                  </button>
                ))}
              </div>
              <div style={{ marginTop:12 }}>
                <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>Or enter custom radius (meters)</label>
                <input type="number" style={{ ...inp, width:160 }} min={10} max={2000}
                  value={cfg.radius_meters} onChange={e => setCfg(p => ({...p, radius_meters:+e.target.value}))}/>
              </div>
            </div>

            {/* Toggles */}
            {[
              { key:'strict_mode',     label:'Strict Mode',     desc:'Block check-in entirely if outside geo-fence boundary' },
              { key:'allow_override',  label:'Allow Override',  desc:'Let supervisors manually approve out-of-range check-ins' },
            ].map(opt => (
              <div key={opt.key} style={{ background:C.s3, borderRadius:14, padding:18, border:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center', gap:16 }}>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:C.white }}>{opt.label}</div>
                  <div style={{ fontSize:12, color:C.gray, marginTop:2 }}>{opt.desc}</div>
                </div>
                <Tog val={(cfg as any)[opt.key]} onChange={v => setCfg(p => ({...p, [opt.key]:v}))}/>
              </div>
            ))}

            {/* Live preview */}
            <div style={{ background:`${C.blue}08`, border:`1px solid ${C.blue}28`, borderRadius:14, padding:18 }}>
              <div style={{ fontSize:11, color:C.blue, fontWeight:700, marginBottom:12, letterSpacing:'0.8px', textTransform:'uppercase' }}>Preview</div>
              <div style={{ display:'flex', justifyContent:'center' }}>
                <div style={{ position:'relative', width:140, height:140 }}>
                  {[140,100,60].map((sz,i) => (
                    <div key={i} style={{ position:'absolute', width:sz, height:sz, borderRadius:'50%', border:`1px solid ${C.blue}${['20','14','0a'][i]}`, top:'50%', left:'50%', transform:'translate(-50%,-50%)' }}/>
                  ))}
                  <div style={{ position:'absolute', width:10, height:10, borderRadius:'50%', background:C.red, top:'50%', left:'50%', transform:'translate(-50%,-50%)', boxShadow:`0 0 12px ${C.red}` }}/>
                  <div style={{ position:'absolute', top:'50%', left:'50%', transform:'translate(-50%,-50%)', fontFamily:"'Syne',sans-serif", fontSize:11, fontWeight:800, color:C.blue, whiteSpace:'nowrap', marginTop:28 }}>{cfg.radius_meters}m</div>
                </div>
              </div>
            </div>
          </div>
          <SaveBar saving={saving} saved={saved} onSave={save}/>
        </>
      )}
    </div>
  );
}

/* ══ SECTION: Working Hours ══ */
function WorkingHoursSection() {
  const [cfg, setCfg] = useState({ min_hours:8, grace_minutes:15, track_breaks:true, max_break_minutes:60 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved]   = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<any>('/api/v1/settings/working_hours').then(d => { if (d) setCfg(d); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setSaved(false);
    try { await post('/api/v1/settings/working_hours', cfg); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    catch {}
    setSaving(false);
  };

  return (
    <div>
      <SectionHeader icon="⏱️" title="Minimum Working Hours" desc="Set daily working hour requirements and break policies for field executives"/>
      {loading ? <div style={{ padding:'32px', display:'flex', justifyContent:'center' }}><Spin/></div> : (
        <>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 }}>
            {[
              { key:'min_hours',         label:'Minimum Hours / Day', desc:'Minimum hours an FE must log daily', min:1,  max:12, unit:'hrs',  step:0.5 },
              { key:'grace_minutes',     label:'Grace Period',        desc:'Late check-in allowance before marking absent', min:0, max:60, unit:'min', step:5 },
              { key:'max_break_minutes', label:'Max Break Duration',  desc:'Maximum allowed break time per day', min:15, max:180, unit:'min', step:15 },
            ].map(f => (
              <div key={f.key} style={{ background:C.s3, borderRadius:14, padding:18, border:`1px solid ${C.border}` }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.white, marginBottom:3 }}>{f.label}</div>
                <div style={{ fontSize:11, color:C.gray, marginBottom:12 }}>{f.desc}</div>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <input type="number" style={{ ...inp, width:90 }} min={f.min} max={f.max} step={f.step}
                    value={(cfg as any)[f.key]} onChange={e => setCfg(p => ({...p, [f.key]:+e.target.value}))}/>
                  <span style={{ fontSize:13, color:C.gray, fontWeight:600 }}>{f.unit}</span>
                </div>
                {/* Progress bar */}
                <div style={{ marginTop:10, height:4, background:C.s4, borderRadius:2, overflow:'hidden' }}>
                  <div style={{ height:'100%', borderRadius:2, background:C.blue, width:`${Math.min(((cfg as any)[f.key]-f.min)/(f.max-f.min)*100, 100)}%`, transition:'width .3s' }}/>
                </div>
              </div>
            ))}

            <div style={{ background:C.s3, borderRadius:14, padding:18, border:`1px solid ${C.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div>
                <div style={{ fontSize:13, fontWeight:700, color:C.white }}>Track Breaks</div>
                <div style={{ fontSize:11, color:C.gray, marginTop:2 }}>Log break start/end times in attendance records</div>
              </div>
              <Tog val={cfg.track_breaks} onChange={v => setCfg(p => ({...p, track_breaks:v}))}/>
            </div>
          </div>

          {/* Summary card */}
          <div style={{ marginTop:16, background:`${C.green}08`, border:`1px solid ${C.green}22`, borderRadius:14, padding:16, display:'flex', gap:24, flexWrap:'wrap' }}>
            {[
              { l:'Min Hours', v:`${cfg.min_hours}h / day`, c:C.green },
              { l:'Grace Period', v:`${cfg.grace_minutes} min`, c:C.yellow },
              { l:'Max Break', v:`${cfg.max_break_minutes} min`, c:C.blue },
              { l:'Break Tracking', v:cfg.track_breaks?'Enabled':'Disabled', c:cfg.track_breaks?C.green:C.grayd },
            ].map((s,i) => (
              <div key={i}>
                <div style={{ fontSize:10, color:C.grayd, marginBottom:2 }}>{s.l}</div>
                <div style={{ fontSize:14, fontWeight:800, color:s.c, fontFamily:"'Syne',sans-serif" }}>{s.v}</div>
              </div>
            ))}
          </div>
          <SaveBar saving={saving} saved={saved} onSave={save}/>
        </>
      )}
    </div>
  );
}

/* ══ SECTION: Role Access ══ */
const PAGES = [
  { id:'dashboard',        label:'Dashboard',        icon:'📊' },
  { id:'hr',               label:'HR & Hiring',      icon:'👥' },
  { id:'field_executives', label:'Field Executives', icon:'👤' },
  { id:'live_tracking',    label:'Live Tracking',    icon:'📍' },
  { id:'broadcast',        label:'Broadcast',        icon:'📡' },
  { id:'notifications',    label:'Notifications',    icon:'🔔' },
  { id:'leaderboard',      label:'Leaderboard',      icon:'🏆' },
  { id:'learning',         label:'Learning Center',  icon:'📚' },
  { id:'reports',          label:'Reports',          icon:'📈' },
  { id:'settings',         label:'Settings',         icon:'⚙️' },
];

const ROLES = [
  { id:'admin',        label:'Admin',        color:C.red    },
  { id:'city_manager', label:'City Manager', color:C.blue   },
  { id:'supervisor',   label:'Supervisor',   color:C.purple },
];

function RoleAccessSection() {
  const defaultMatrix = {
    admin:        Object.fromEntries(PAGES.map(p => [p.id, true])),
    city_manager: Object.fromEntries(PAGES.map(p => [p.id, !['hr','settings'].includes(p.id)])),
    supervisor:   Object.fromEntries(PAGES.map(p => [p.id, ['dashboard','field_executives','live_tracking','leaderboard','learning'].includes(p.id)])),
  };
  const [matrix, setMatrix] = useState<any>(defaultMatrix);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    get<any>('/api/v1/settings/role_access').then(d => { if (d && typeof d === 'object') setMatrix(d); }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const toggle = (role: string, page: string) => {
    if (role === 'admin' && page === 'settings') return; // admin always has settings
    setMatrix((p: any) => ({ ...p, [role]: { ...p[role], [page]: !p[role]?.[page] } }));
  };

  const save = async () => {
    setSaving(true); setSaved(false);
    try { await post('/api/v1/settings/role_access', matrix); setSaved(true); setTimeout(() => setSaved(false), 3000); }
    catch {}
    setSaving(false);
  };

  return (
    <div>
      <SectionHeader icon="🔐" title="User Role Access" desc="Control which sections each role can access in the admin panel"/>
      {loading ? <div style={{ padding:'32px', display:'flex', justifyContent:'center' }}><Spin/></div> : (
        <>
          <div style={{ background:C.s3, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden' }}>
            {/* Header row */}
            <div style={{ display:'grid', gridTemplateColumns:`200px repeat(${ROLES.length}, 1fr)`, borderBottom:`1px solid ${C.border}` }}>
              <div style={{ padding:'12px 16px', fontSize:11, color:C.grayd, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px' }}>Page / Feature</div>
              {ROLES.map(r => (
                <div key={r.id} style={{ padding:'12px 16px', textAlign:'center' }}>
                  <div style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'4px 12px', borderRadius:20, background:`${r.color}18`, color:r.color, fontSize:12, fontWeight:700 }}>
                    {r.label}
                  </div>
                </div>
              ))}
            </div>
            {/* Page rows */}
            {PAGES.map((page, pi) => (
              <div key={page.id} style={{ display:'grid', gridTemplateColumns:`200px repeat(${ROLES.length}, 1fr)`, borderBottom:pi<PAGES.length-1?`1px solid ${C.border}`:'none', transition:'background .13s' }}
                onMouseEnter={e => (e.currentTarget.style.background=C.s4)}
                onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
                <div style={{ padding:'13px 16px', display:'flex', alignItems:'center', gap:8 }}>
                  <span style={{ fontSize:15 }}>{page.icon}</span>
                  <span style={{ fontSize:13, color:C.white, fontWeight:600 }}>{page.label}</span>
                </div>
                {ROLES.map(role => {
                  const on = matrix[role.id]?.[page.id] ?? false;
                  const locked = role.id === 'admin'; // admin always on
                  return (
                    <div key={role.id} style={{ padding:'13px 16px', display:'flex', alignItems:'center', justifyContent:'center' }}>
                      <div onClick={() => !locked && toggle(role.id, page.id)}
                        style={{ width:24, height:24, borderRadius:6, border:`1.5px solid ${on?role.color:C.border}`, background:on?`${role.color}20`:C.s3, display:'flex', alignItems:'center', justifyContent:'center', cursor:locked?'default':'pointer', transition:'all .15s', opacity:locked?0.5:1 }}>
                        {on && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={role.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {/* Role summary */}
          <div style={{ display:'flex', gap:10, marginTop:14, flexWrap:'wrap' }}>
            {ROLES.map(r => {
              const count = PAGES.filter(p => matrix[r.id]?.[p.id]).length;
              return (
                <div key={r.id} style={{ flex:1, background:C.s3, border:`1px solid ${C.border}`, borderRadius:12, padding:'12px 16px', minWidth:140 }}>
                  <div style={{ fontSize:12, color:r.color, fontWeight:700, marginBottom:2 }}>{r.label}</div>
                  <div style={{ fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800, color:C.white }}>{count}<span style={{ fontSize:13, color:C.grayd }}>/{PAGES.length}</span></div>
                  <div style={{ fontSize:11, color:C.grayd }}>pages accessible</div>
                </div>
              );
            })}
          </div>
          <SaveBar saving={saving} saved={saved} onSave={save}/>
        </>
      )}
    </div>
  );
}

/* ══ SECTION: City Management ══ */
function CitySection() {
  const [cities,   setCities]  = useState<City[]>([]);
  const [loading,  setLoading] = useState(true);
  const [showAdd,  setShowAdd] = useState(false);
  const [form,     setForm]    = useState({ name:'', state:'' });
  const [saving,   setSaving]  = useState(false);
  const [err,      setErr]     = useState('');
  const [search,   setSearch]  = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await get<any>('/api/v1/cities');
      const list = Array.isArray(data) ? data : (data?.data ?? []);
      setCities(list);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async () => {
    if (!form.name.trim()) { setErr('City name is required'); return; }
    setSaving(true); setErr('');
    try {
      await post('/api/v1/cities', { name: form.name.trim(), state: form.state.trim() || null });
      setForm({ name:'', state:'' }); setShowAdd(false); load();
    } catch { setErr('Failed to add city'); }
    setSaving(false);
  };

  const toggleActive = async (city: City) => {
    try {
      await patch(`/api/v1/cities/${city.id}`, { is_active: !city.is_active });
      load();
    } catch {}
  };

  const filtered = cities.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.state?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      <SectionHeader icon="🏙️" title="City Management" desc="Manage cities used across FE assignments, outlets, zones and notifications"/>
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13, color:C.grayd }}>🔍</span>
          <input placeholder="Search cities…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...inp, paddingLeft:30 }}/>
        </div>
        <button onClick={() => { setShowAdd(true); setErr(''); setForm({ name:'', state:'' }); }}
          style={{ padding:'9px 18px', background:C.red, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif", display:'flex', alignItems:'center', gap:7, boxShadow:`0 4px 16px ${C.redB}` }}>
          + Add City
        </button>
      </div>

      {/* Stats */}
      <div style={{ display:'flex', gap:10, marginBottom:16 }}>
        {[
          { l:'Total',    v:cities.length,                               c:C.blue   },
          { l:'Active',   v:cities.filter(c=>c.is_active).length,        c:C.green  },
          { l:'Inactive', v:cities.filter(c=>!c.is_active).length,       c:C.grayd  },
        ].map((s,i) => (
          <div key={i} style={{ flex:1, background:C.s3, border:`1px solid ${C.border}`, borderRadius:12, padding:'12px 16px', textAlign:'center' }}>
            <div style={{ fontFamily:"'Syne',sans-serif", fontSize:22, fontWeight:800, color:s.c }}>{loading?'—':s.v}</div>
            <div style={{ fontSize:11, color:C.grayd, marginTop:2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:C.s3, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 100px 80px', padding:'10px 16px', borderBottom:`1px solid ${C.border}` }}>
          {['City Name','State / Region','Status','Action'].map(h => (
            <div key={h} style={{ fontSize:11, color:C.grayd, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px' }}>{h}</div>
          ))}
        </div>
        {loading ? (
          <div style={{ padding:'32px', display:'flex', justifyContent:'center' }}><Spin/></div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:'32px', textAlign:'center', color:C.grayd, fontSize:13 }}>
            {search ? `No cities matching "${search}"` : 'No cities yet — add your first city'}
          </div>
        ) : filtered.map((city, i) => (
          <div key={city.id} style={{ display:'grid', gridTemplateColumns:'1fr 1fr 100px 80px', padding:'13px 16px', borderBottom:i<filtered.length-1?`1px solid ${C.border}`:'none', alignItems:'center' }}
            onMouseEnter={e => (e.currentTarget.style.background=C.s4)}
            onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
            <div style={{ display:'flex', alignItems:'center', gap:9 }}>
              <div style={{ width:30, height:30, borderRadius:8, background:`${C.blue}18`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14 }}>🏙️</div>
              <span style={{ fontSize:13, fontWeight:700, color:C.white }}>{city.name}</span>
            </div>
            <div style={{ fontSize:13, color:C.gray }}>{city.state || '—'}</div>
            <Tag label={city.is_active?'Active':'Inactive'} color={city.is_active?C.green:C.grayd}/>
            <div>
              <Tog val={city.is_active} onChange={() => toggleActive(city)}/>
            </div>
          </div>
        ))}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:C.s2, border:`1px solid ${C.border}`, borderRadius:18, padding:28, width:380, boxShadow:'0 24px 80px rgba(0,0,0,.8)' }}>
            <div style={{ fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:800, color:C.white, marginBottom:20 }}>Add New City</div>
            <div style={{ marginBottom:14 }}>
              <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>City Name <span style={{ color:C.red }}>*</span></label>
              <input style={inp} placeholder="e.g. Mumbai" value={form.name} onChange={e => setForm(p => ({...p, name:e.target.value}))}/>
            </div>
            <div style={{ marginBottom:16 }}>
              <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>State / Region</label>
              <input style={inp} placeholder="e.g. Maharashtra" value={form.state} onChange={e => setForm(p => ({...p, state:e.target.value}))}/>
            </div>
            {err && <div style={{ fontSize:12, color:C.red, marginBottom:12 }}>⚠ {err}</div>}
            <div style={{ display:'flex', gap:10 }}>
              <button onClick={() => setShowAdd(false)} style={{ flex:1, padding:'10px', background:C.s3, border:`1px solid ${C.border}`, borderRadius:10, color:C.gray, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
              <button onClick={add} disabled={saving} style={{ flex:1, padding:'10px', background:C.red, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif", opacity:saving?0.6:1, display:'flex', alignItems:'center', justifyContent:'center', gap:7 }}>
                {saving ? <><Spin/>Adding…</> : '+ Add City'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══ SECTION: User Management ══ */
const ROLE_COLORS: Record<string,string> = { admin:C.red, city_manager:C.blue, supervisor:C.purple, executive:C.green };

function UserSection() {
  const [users,   setUsers]   = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');
  const [roleF,   setRoleF]   = useState('all');
  const [showAdd, setShowAdd] = useState(false);
  const [form,    setForm]    = useState({ name:'', mobile:'', email:'', role:'executive', employee_id:'', city:'' });
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState('');
  const [cities,  setCities]  = useState<City[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [uData, cData] = await Promise.all([
        get<any>('/api/v1/users?limit=500'),
        get<any>('/api/v1/cities'),
      ]);
      const users = Array.isArray(uData) ? uData : (uData?.data ?? uData?.users ?? []);
      setUsers(users);
      const cityList = Array.isArray(cData) ? cData : (cData?.data ?? []);
      setCities(cityList.filter((c:any) => c.is_active !== false));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const addUser = async () => {
    if (!form.name.trim() || !form.mobile.trim()) { setErr('Name and mobile are required'); return; }
    if (form.mobile.length !== 10) { setErr('Mobile must be 10 digits'); return; }
    setSaving(true); setErr('');
    try {
      await post('/api/v1/users', form);
      setShowAdd(false);
      setForm({ name:'', mobile:'', email:'', role:'executive', employee_id:'', city:'' });
      load();
    } catch (e:any) { setErr(e.message || 'Failed to add user'); }
    setSaving(false);
  };

  const toggleActive = async (user: User) => {
    try { await patch(`/api/v1/users/${user.id}`, { is_active: !user.is_active }); load(); } catch {}
  };

  const roles = ['all','admin','city_manager','supervisor','executive'];
  const filtered = users.filter(u => {
    const mq = !search || u.name?.toLowerCase().includes(search.toLowerCase()) || u.mobile?.includes(search) || u.employee_id?.toLowerCase().includes(search.toLowerCase());
    const mr = roleF === 'all' || u.role === roleF;
    return mq && mr;
  });

  return (
    <div>
      <SectionHeader icon="👤" title="User Management" desc="Manage all admin panel users — admins, city managers and supervisors"/>

      {/* Filters */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        <div style={{ position:'relative', flex:1, minWidth:200 }}>
          <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:13, color:C.grayd }}>🔍</span>
          <input placeholder="Search by name, mobile, employee ID…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...inp, paddingLeft:30 }}/>
        </div>
        <select value={roleF} onChange={e => setRoleF(e.target.value)}
          style={{ ...inp, width:'auto', minWidth:150, appearance:'none' as any }}>
          {roles.map(r => <option key={r} value={r}>{r==='all'?'All Roles':r.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}</option>)}
        </select>
        <button onClick={() => { setShowAdd(true); setErr(''); }}
          style={{ padding:'9px 18px', background:C.red, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif", display:'flex', alignItems:'center', gap:7, boxShadow:`0 4px 16px ${C.redB}` }}>
          + Add User
        </button>
      </div>

      {/* Stats */}
      <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
        {[
          { l:'Total',        v:users.length,                                          c:C.white  },
          { l:'Admin',        v:users.filter(u=>u.role==='admin').length,              c:C.red    },
          { l:'City Manager', v:users.filter(u=>u.role==='city_manager').length,       c:C.blue   },
          { l:'Supervisor',   v:users.filter(u=>u.role==='supervisor').length,         c:C.purple },
          { l:'FE',           v:users.filter(u=>u.role==='executive').length,          c:C.green  },
          { l:'Active',       v:users.filter(u=>u.is_active).length,                  c:C.green  },
        ].map((s,i) => (
          <div key={i} style={{ flex:1, minWidth:80, background:C.s3, border:`1px solid ${C.border}`, borderRadius:12, padding:'10px 14px', textAlign:'center' }}>
            <div style={{ fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, color:s.c }}>{loading?'—':s.v}</div>
            <div style={{ fontSize:10, color:C.grayd, marginTop:2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:C.s3, borderRadius:14, border:`1px solid ${C.border}`, overflow:'hidden' }}>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 120px 140px 100px 70px', padding:'10px 16px', borderBottom:`1px solid ${C.border}` }}>
          {['User','Role','City','Status','Active'].map(h => (
            <div key={h} style={{ fontSize:11, color:C.grayd, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.8px' }}>{h}</div>
          ))}
        </div>
        {loading ? (
          <div style={{ padding:'32px', display:'flex', justifyContent:'center' }}><Spin/></div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:'32px', textAlign:'center', color:C.grayd, fontSize:13 }}>No users found</div>
        ) : filtered.map((user, i) => {
          const rc = ROLE_COLORS[user.role] || C.gray;
          return (
            <div key={user.id} style={{ display:'grid', gridTemplateColumns:'1fr 120px 140px 100px 70px', padding:'12px 16px', borderBottom:i<filtered.length-1?`1px solid ${C.border}`:'none', alignItems:'center' }}
              onMouseEnter={e => (e.currentTarget.style.background=C.s4)}
              onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ width:34, height:34, borderRadius:'50%', background:`${rc}20`, border:`1.5px solid ${rc}60`, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:"'Syne',sans-serif", fontWeight:800, fontSize:14, color:rc, flexShrink:0 }}>
                  {(user.name||'?')[0].toUpperCase()}
                </div>
                <div>
                  <div style={{ fontSize:13, fontWeight:700, color:C.white }}>{user.name}</div>
                  <div style={{ fontSize:11, color:C.grayd }}>{user.employee_id||''}{user.mobile?` · ${user.mobile}`:''}</div>
                </div>
              </div>
              <Tag label={user.role.replace('_',' ')} color={rc}/>
              <div style={{ fontSize:12, color:C.gray }}>{user.city||'—'}</div>
              <Tag label={user.is_active?'Active':'Inactive'} color={user.is_active?C.green:C.grayd}/>
              <Tog val={user.is_active} onChange={() => toggleActive(user)}/>
            </div>
          );
        })}
      </div>

      {/* Add modal */}
      {showAdd && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.7)', zIndex:200, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:C.s2, border:`1px solid ${C.border}`, borderRadius:18, padding:28, width:420, boxShadow:'0 24px 80px rgba(0,0,0,.8)', maxHeight:'90vh', overflowY:'auto' }}>
            <div style={{ fontFamily:"'Syne',sans-serif", fontSize:18, fontWeight:800, color:C.white, marginBottom:20 }}>Add New User</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {[
                { key:'name',        label:'Full Name',    ph:'e.g. Rahul Sharma',   req:true },
                { key:'mobile',      label:'Mobile',       ph:'10-digit number',     req:true },
                { key:'email',       label:'Email',        ph:'user@example.com',    req:false },
                { key:'employee_id', label:'Employee ID',  ph:'e.g. FE-003',         req:false },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>{f.label}{f.req&&<span style={{ color:C.red }}> *</span>}</label>
                  <input style={inp} placeholder={f.ph}
                    value={(form as any)[f.key]}
                    onChange={e => setForm(p => ({...p, [f.key]:e.target.value}))}
                    maxLength={f.key==='mobile'?10:undefined}/>
                </div>
              ))}
              <div>
                <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>Role <span style={{ color:C.red }}>*</span></label>
                <select style={{ ...inp, appearance:'none' as any }} value={form.role} onChange={e => setForm(p => ({...p, role:e.target.value}))}>
                  <option value="executive">Field Executive</option>
                  <option value="supervisor">Supervisor</option>
                  <option value="city_manager">City Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize:12, color:C.gray, display:'block', marginBottom:6 }}>City</label>
                <select style={{ ...inp, appearance:'none' as any }} value={form.city} onChange={e => setForm(p => ({...p, city:e.target.value}))}>
                  <option value="">Select city…</option>
                  {(Array.isArray(cities)?cities:[]).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </div>
            </div>
            {err && <div style={{ fontSize:12, color:C.red, marginTop:12 }}>⚠ {err}</div>}
            <div style={{ display:'flex', gap:10, marginTop:20 }}>
              <button onClick={() => setShowAdd(false)} style={{ flex:1, padding:'10px', background:C.s3, border:`1px solid ${C.border}`, borderRadius:10, color:C.gray, fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:"'DM Sans',sans-serif" }}>Cancel</button>
              <button onClick={addUser} disabled={saving} style={{ flex:1, padding:'10px', background:C.red, border:'none', borderRadius:10, color:'#fff', fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'DM Sans',sans-serif", opacity:saving?0.6:1, display:'flex', alignItems:'center', justifyContent:'center', gap:7 }}>
                {saving ? <><Spin/>Adding…</> : '+ Add User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Section header helper ── */
function SectionHeader({ icon, title, desc }: { icon:string; title:string; desc:string }) {
  return (
    <div style={{ marginBottom:24 }}>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:6 }}>
        <span style={{ fontSize:22 }}>{icon}</span>
        <h2 style={{ fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, color:C.white, margin:0 }}>{title}</h2>
      </div>
      <p style={{ fontSize:13, color:C.gray, margin:0, paddingLeft:32 }}>{desc}</p>
    </div>
  );
}

/* ══ MAIN PAGE ══ */
const NAV = [
  { id:'geofence',      icon:'📍', label:'Geo-fence',       desc:'Radius & rules'         },
  { id:'hours',         icon:'⏱️', label:'Working Hours',   desc:'Min hours & breaks'     },
  { id:'role_access',   icon:'🔐', label:'Role Access',     desc:'Page permissions'       },
  { id:'cities',        icon:'🏙️', label:'City Management', desc:'Add & manage cities'    },
  { id:'users',         icon:'👤', label:'User Management', desc:'Admins & supervisors'   },
];

export default function SettingsPage() {
  const [active, setActive] = useState('geofence');

  const renderSection = () => {
    switch (active) {
      case 'geofence':    return <GeofenceSection/>;
      case 'hours':       return <WorkingHoursSection/>;
      case 'role_access': return <RoleAccessSection/>;
      case 'cities':      return <CitySection/>;
      case 'users':       return <UserSection/>;
      default:            return null;
    }
  };

  return (
    <>
      <style>{`
        @keyframes sspin { to { transform:rotate(360deg) } }
        @keyframes sfadein { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        * { box-sizing:border-box; }
      `}</style>
      <div style={{ display:'flex', gap:0, minHeight:'calc(100vh - 80px)', animation:'sfadein .3s ease' }}>

        {/* ── Sidebar ── */}
        <div style={{ width:240, flexShrink:0, background:C.s2, borderRight:`1px solid ${C.border}`, padding:'8px 0', display:'flex', flexDirection:'column' }}>
          <div style={{ padding:'16px 20px 12px' }}>
            <div style={{ fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800, color:C.white }}>Settings</div>
            <div style={{ fontSize:11, color:C.grayd, marginTop:2 }}>Platform configuration</div>
          </div>
          <div style={{ height:1, background:C.border, margin:'0 16px 8px' }}/>
          {NAV.map(n => {
            const isActive = active === n.id;
            return (
              <div key={n.id} onClick={() => setActive(n.id)}
                style={{ margin:'2px 10px', borderRadius:10, padding:'10px 14px', cursor:'pointer', transition:'all .15s',
                  background: isActive ? C.redD : 'transparent',
                  borderLeft: isActive ? `3px solid ${C.red}` : '3px solid transparent',
                  display:'flex', alignItems:'center', gap:12 }}
                onMouseEnter={e => !isActive && (e.currentTarget.style.background=C.s3)}
                onMouseLeave={e => !isActive && (e.currentTarget.style.background='transparent')}>
                <span style={{ fontSize:18, flexShrink:0 }}>{n.icon}</span>
                <div>
                  <div style={{ fontSize:13, fontWeight:isActive?700:600, color:isActive?C.red:C.white }}>{n.label}</div>
                  <div style={{ fontSize:11, color:C.grayd }}>{n.desc}</div>
                </div>
              </div>
            );
          })}
        </div>

        {/* ── Content ── */}
        <div style={{ flex:1, padding:'28px 32px', overflowY:'auto', background:C.bg }}>
          <div key={active} style={{ animation:'sfadein .25s ease', maxWidth:860 }}>
            {renderSection()}
          </div>
        </div>
      </div>
    </>
  );
}
