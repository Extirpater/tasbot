import { ACTIONS, circleInZone } from "../planner.js";

const clamp = (v,lo,hi) => Math.max(lo,Math.min(hi,v));

function futureIceShot(hazard,area,playerRadius,tickRate) {
  const gun=hazard.sniper,z=area.zones.find(z=>z.type===0 && circleInZone(hazard,z));
  const left=z.x+hazard.radius,right=z.x+z.width-hazard.radius;
  const top=z.y+hazard.radius,bottom=z.y+z.height-hazard.radius;
  return {
    id:`future-shot:${hazard.id}`,family:"forecast_ice_bullet",entityType:9999,
    x:hazard.x,y:hazard.y,vx:hazard.vx,vy:hazard.vy,bounce:false,
    // A newly created projectile group can start moving one native update
    // later than an existing group. Cover both schedules without RNG access.
    radius:gun.bulletRadius+gun.bulletSpeed/tickRate,
    // Skip this forecast entirely when its earliest shot is beyond the
    // current planning horizon; the existing shooter body remains lethal.
    harmlessUntilMs:Math.max(0,gun.interval-gun.clock),
    reactive:{range:gun.range+128,maxSpeed:Math.max(gun.bulletSpeed,Math.hypot(hazard.vx,hazard.vy)),
      initial:{x:hazard.x,y:hazard.y,vx:hazard.vx,vy:hazard.vy,clock:gun.clock,born:false},
      step(p,bounds,target,dt,scale,timeMs,targetAfter=target) {
        p.x+=p.vx*dt;p.y+=p.vy*dt;
        if(p.born)return;
        if(p.x<left||p.x>right)p.vx=-p.vx;
        if(p.y<top||p.y>bottom)p.vy=-p.vy;
        p.clock+=dt*1000;
        const exposed=target && target.x<z.x+z.width+16 && target.x+playerRadius>z.x &&
          target.y<z.y+z.height+16 && target.y+playerRadius>z.y;
        if(p.clock>gun.interval && exposed && targetAfter &&
          targetAfter.x>=z.x && targetAfter.x<=z.x+z.width &&
          targetAfter.y>=z.y && targetAfter.y<=z.y+z.height &&
          (targetAfter.x-p.x)**2+(targetAfter.y-p.y)**2<gun.range**2) {
          const angle=Math.atan2(targetAfter.y-p.y,targetAfter.x-p.x);
          p.born=true;p.vx=Math.cos(angle)*gun.bulletSpeed;p.vy=Math.sin(angle)*gun.bulletSpeed;
        } else {
          // Before firing this proxy remains inside its parent's body.
          p.x=clamp(p.x,left,right);p.y=clamp(p.y,top,bottom);
        }
      },
    },
  };
}

function liquidModel(hazard,area,playerRadius) {
  const liquid=hazard.liquid;
  return {
    // Activate private branch simulation before either body can enter the
    // detection range this tick. The actual behavior still tests exact range.
    range:liquid.range+128,maxSpeed:Math.hypot(liquid.vx,liquid.vy)*5,
    initial:{x:hazard.x,y:hazard.y,vx:liquid.vx,vy:liquid.vy,multiplier:liquid.multiplier},
    step(p,bounds,target,dt,scale,timeMs,targetAfter=target) {
      p.x+=p.vx*p.multiplier*dt*scale;p.y+=p.vy*p.multiplier*dt*scale;
      if(p.x<bounds.left || p.x>bounds.right)p.vx=-p.vx;
      if(p.y<bounds.top || p.y>bounds.bottom)p.vy=-p.vy;
      const exposed=target && area.zones.some(z=>z.type===0 && target.x<z.x+z.width+16 &&
        target.x+playerRadius>z.x && target.y<z.y+z.height+16 && target.y+playerRadius>z.y);
      p.multiplier=exposed && targetAfter &&
        (targetAfter.x-p.x)**2+(targetAfter.y-p.y)**2<liquid.range**2?5:1;
      p.x=clamp(p.x,bounds.left,bounds.right);p.y=clamp(p.y,bounds.top,bounds.bottom);
    },
  };
}

// Lazily predict ordinary Ravel bounces, including the discarded overshoot.
// Each cache belongs to one observation and contains only model predictions.
function bouncePositions(h,area,rate) {
  const z=area.zones.find(z=>z.type===0 && circleInZone(h,z));
  const points=[{x:h.x,y:h.y}];let vx=h.vx,vy=h.vy;
  return tick=>{
    while(points.length<=tick) {
      let {x,y}=points.at(-1);x+=vx/rate;y+=vy/rate;
      if(z && h.bounce!==false) {
        if(x<z.x+h.radius || x>z.x+z.width-h.radius)vx=-vx;
        if(y<z.y+h.radius || y>z.y+z.height-h.radius)vy=-vy;
        x=clamp(x,z.x+h.radius,z.x+z.width-h.radius);
        y=clamp(y,z.y+h.radius,z.y+z.height-h.radius);
      }
      points.push({x,y});
    }
    return points[tick];
  };
}

function slipperyModel(state) {
  const rate=state.tickRate??60, area=state.area;
  const auras=state.hazards.filter(h=>h.family==="slippery")
    .map(h=>({radius:state.player.radius+h.auraRadius,at:bouncePositions(h,area,rate)}));
  const initial=state.player.slip;
  return (position,action,player,area,dt,auraMultiplier)=>{
    const before=position.motionState??initial;
    const direction=ACTIONS[action];
    const dx=before.locked?before.dx:direction.dx,dy=before.locked?before.dy:direction.dy;
    const angle=before.locked?before.angle:Math.atan2(dy,dx);
    const zone=area.zones.find(z=>circleInZone(position,z));
    const base=before.active?player.baseSpeed:Math.max(player.baseSpeed,zone?.minimumSpeed??0);
    const speed=player.immobilized?0:base*before.wallBoost*auraMultiplier+(player.speedBonus??0);
    let vx,vy,carryVx=0,carryVy=0;
    if(before.active) {
      // Slipping normalizes diagonal motion, ignores Shift and keeps moving
      // even after releasing keys. Steering unlocks on a wall collision.
      vx=Math.cos(angle)*speed;vy=Math.sin(angle)*speed;
    } else {
      const cap=speed*(direction.scale??1),friction=1-(zone?.friction??1);
      vx=clamp(dx*cap+before.carryVx*friction,-cap,cap);
      vy=clamp(dy*cap+before.carryVy*friction,-cap,cap);
      if(Math.abs(vx)<0.03)vx=0;if(Math.abs(vy)<0.03)vy=0;
      carryVx=vx;carryVy=vy;
    }
    const rawX=position.x+vx*dt,rawY=position.y+vy*dt;
    const x=clamp(rawX,area.x+player.radius,area.x+area.width-player.radius);
    const y=clamp(rawY,area.y+player.radius,area.y+area.height-player.radius);
    const wall=x!==rawX||y!==rawY;
    // Ravel evaluates shelter before the player moves and applies auras
    // after enemies move; their result controls the next player update.
    const exposed=area.zones.some(z=>z.type===0 && position.x<z.x+z.width+16 &&
      position.x+player.radius>z.x && position.y<z.y+z.height+16 && position.y+player.radius>z.y);
    const tick=Math.round(((position.time??0)+dt)*rate);
    const active=exposed && auras.some(a=>{
      const p=a.at(tick);return (x-p.x)**2+(y-p.y)**2<a.radius**2;
    });
    return {x,y,vx:x===position.x?0:vx,vy:y===position.y?0:vy,
      motionState:{active,locked:before.active&&!wall,angle,dx,dy,carryVx,carryVy,
        wallBoost:before.active&&wall?2:1}};
  };
}

export function predictDasherPath(hazard,area,steps,dt,tickRate=60) {
  const z=area.zones.find(z=>z.type===0 && circleInZone(hazard,z));
  const left=z.x+hazard.radius,right=z.x+z.width-hazard.radius;
  const top=z.y+hazard.radius,bottom=z.y+z.height-hazard.radius;
  let {x,y}=hazard,speed=Math.hypot(hazard.vx,hazard.vy);
  let {preparing,dashing,resting,peak,dx,dy}=hazard.dash;
  const tickMs=1000/tickRate,fine=[{x,y}];
  for(let tick=0;tick<Math.ceil(steps*dt*tickRate);tick++) {
    // Ravel moves with the previous update's speed before changing phase.
    x+=dx*speed/tickRate;y+=dy*speed/tickRate;
    if(x<left||x>right)dx=-dx;if(y<top||y>bottom)dy=-dy;
    x=clamp(x,left,right);y=clamp(y,top,bottom);
    if(preparing>0) {
      preparing+=tickMs;
      if(preparing>750){preparing=0;dashing+=tickMs;speed=peak;}
      else speed=peak/5*(1-preparing/750);
    } else if(dashing>0) {
      dashing+=tickMs;
      if(dashing>3000){dashing=0;speed=0;}
      else speed=peak*(1-dashing/3000);
    } else if(resting<750)resting+=tickMs;
    else {resting=0;preparing+=tickMs;speed=peak/5;}
    fine.push({x,y});
  }
  return Array.from({length:steps+1},(_,i)=>{
    const at=i*dt*tickRate,lo=Math.min(fine.length-1,Math.floor(at));
    const a=fine[lo],b=fine[Math.min(lo+1,fine.length-1)],f=at-lo;
    return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f};
  });
}

export function predictCurvePath(hazard,area,steps,dt,tickRate=60) {
  const z=area.zones.find(z=>z.type===0 && circleInZone(hazard,z));
  const left=z.x+hazard.radius,right=z.x+z.width-hazard.radius;
  const top=z.y+hazard.radius,bottom=z.y+z.height-hazard.radius;
  let {x,y,vx,vy}=hazard;
  let {remainingMs=Infinity,intervalMs=Infinity,direction,increment,increasing}=hazard.wavy ??
    hazard.spiralPhase ?? {direction:Math.sign(hazard.turningCurve.rate),increment:Math.abs(hazard.turningCurve.rate)/30};
  const fine=[{x,y}];
  for(let tick=0;tick<Math.ceil(steps*dt*tickRate);tick++) {
    x+=vx/tickRate;y+=vy/tickRate;
    const hitX=x<left||x>right,hitY=y<top||y>bottom;
    if(hitX)vx=-vx;if(hitY)vy=-vy;
    if(hitX||hitY)direction=-direction;
    if(hazard.spiralPhase) {
      if(increment<0.001)increasing=true;
      else if(increment>0.35)increasing=false;
      const change=increment<0.05?0.0022:0.004;
      increment+=(increasing?1:-1)*change*(30/tickRate);
    } else {
      if(remainingMs>0)remainingMs-=1000/tickRate;
      else {remainingMs=intervalMs;direction=-direction;}
    }
    const angle=Math.atan2(vy,vx)+increment*(30/tickRate)*direction,speed=Math.hypot(vx,vy);
    vx=Math.cos(angle)*speed;vy=Math.sin(angle)*speed;
    x=clamp(x,left,right);y=clamp(y,top,bottom);fine.push({x,y});
  }
  return Array.from({length:steps+1},(_,i)=>{
    const at=i*dt*tickRate,lo=Math.min(fine.length-1,Math.floor(at));
    const a=fine[lo],b=fine[Math.min(lo+1,fine.length-1)],f=at-lo;
    return {x:a.x+(b.x-a.x)*f,y:a.y+(b.y-a.y)*f};
  });
}

// Source-derived Ravel Icicle model using only present observation + geometry.
// It has no reference to the engine, RNG, player route or actual future state.
export function predictIciclePath(hazard, area, steps, dt, tickRate = 60) {
  const zone = area.zones.find(z => z.type === 0 && circleInZone(hazard, z));
  if (!zone) throw Error("Icicle is outside its active zone");
  const left = zone.x + hazard.radius, right = zone.x + zone.width - hazard.radius;
  const top = zone.y + hazard.radius, bottom = zone.y + zone.height - hazard.radius;
  const tickMs = 1000 / tickRate;
  let x = hazard.x, y = hazard.y;
  let vx = hazard.baseVx ?? hazard.vx, vy = hazard.baseVy ?? hazard.vy;
  const pause = hazard.motionEffects?.find(e => e.name === "icicle wall pause");
  let pausedTicks = pause ? Math.round(pause.remainingMs / tickMs) : 0;
  // The collision update has already added one tick to the wall clock.
  let clock = tickMs, pauseAfterCollision = 0;
  do { clock += tickMs; pauseAfterCollision++; } while (clock <= 1000);
  const fine = [{x,y}];
  for (let tick = 0; tick < Math.ceil(steps * dt * tickRate); tick++) {
    if (pausedTicks > 0) pausedTicks--;
    else {
      x += vx / tickRate; y += vy / tickRate;
      const hitX = x < left || x > right, hitY = y < top || y > bottom;
      if (hitX) vx = -vx;
      if (hitY) vy = -vy;
      // Ravel discards overshoot instead of reflecting the unused distance.
      x = Math.max(left,Math.min(right,x)); y = Math.max(top,Math.min(bottom,y));
      if (hitX || hitY) pausedTicks = pauseAfterCollision;
    }
    fine.push({x,y});
  }
  return Array.from({length:steps+1},(_,i)=>{
    const at = i * dt * tickRate, lo = Math.min(fine.length-1,Math.floor(at));
    const a = fine[lo], b = fine[Math.min(lo+1,fine.length-1)], fraction = at-lo;
    return {x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction};
  });
}

export function withRavelModels(state) {
  if (state.player?.slip) state={...state,player:{...state.player,
    motionState:state.player.slip,predictStep:slipperyModel(state)}};
  if (!state.hazards?.some(h=>h.family === "icicle" || h.dash || h.liquid || h.wavy || h.turningCurve || h.spiralPhase || h.sniper)) return state;
  const hazards=state.hazards.map(h=>
    h.liquid ? {...h,reactive:liquidModel(h,state.area,state.player.radius)} :
    h.dash && h.dash.scale===1 && !h.motionEffects?.length
      ? {...h,predictPath:(area,steps,dt,rate)=>predictDasherPath(h,area,steps,dt,rate)} :
    (h.wavy || h.turningCurve || h.spiralPhase) && !h.motionEffects?.length
      ? {...h,spiral:undefined,predictPath:(area,steps,dt,rate)=>predictCurvePath(h,area,steps,dt,rate)} :
    h.family === "icicle" && (h.motionEffects??[]).every(e=>e.name === "icicle wall pause")
      ? {...h,predictPath:(area,steps,dt,rate)=>predictIciclePath(h,area,steps,dt,rate)}
      : h);
  for(const h of state.hazards)if(h.sniper && !h.motionEffects?.length)
    hazards.push(futureIceShot(h,state.area,state.player.radius,state.tickRate??60));
  return {...state,hazards};
}
