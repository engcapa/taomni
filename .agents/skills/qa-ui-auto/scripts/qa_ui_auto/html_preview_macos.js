// One genuine OS click into the opaque HTML frame. No cross-origin DOM access.
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
const env = $.NSProcessInfo.processInfo.environment;
const read = key => ObjC.unwrap(env.objectForKey(key));
const application = read("QA_HTML_APPLICATION");
const x = Number(read("QA_HTML_CLIENT_X"));
const y = Number(read("QA_HTML_CLIENT_Y"));
const width = Number(read("QA_HTML_CLIENT_WIDTH"));
const height = Number(read("QA_HTML_CLIENT_HEIGHT"));
if (![x,y,width,height].every(Number.isFinite)) throw new Error("Invalid HTML frame geometry");
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const owners = [];
for (let i=0; i<apps.count; i++) {
  const app=apps.objectAtIndex(i);
  try { if (ObjC.unwrap(app.executableURL.path)===application) owners.push(Number(app.processIdentifier)); } catch (_) { }
}
if (owners.length!==1) throw new Error("No unique process for the QA executable");
const events = Application("System Events");
const process = events.processes.whose({unixId:owners[0]})[0];
process.frontmost = true;
const candidates=[];
for (const window of process.windows()) {
  if (window.subrole()!=="AXStandardWindow") continue;
  const nodes=[window];
  for (let depth=0,start=0; depth<8; depth++) {
    const end=nodes.length;
    for(let index=start;index<end;index++) {
      const node=nodes[index];
      try {
        if(node.role()==="AXWebArea") {
          const size=node.size(),position=node.position();
          if(Math.abs(size[0]-width)<=4&&Math.abs(size[1]-height)<=4) candidates.push({position,size});
        }
      } catch (_) { }
      try { nodes.push(...node.uiElements()); } catch (_) { }
    }
    start=end;
  }
}
if(candidates.length!==1) throw new Error("Cannot uniquely align the QA AXWebArea with its viewport; no click sent");
const area=candidates[0];
const px=area.position[0]+x, py=area.position[1]+y;
if(x<=0||y<=0||x>=area.size[0]||y>=area.size[1]) throw new Error("HTML target outside owned WebArea");
const point=$.CGPointMake(px,py);
const down=$.CGEventCreateMouseEvent(null,1,point,0);
const up=$.CGEventCreateMouseEvent(null,2,point,0);
if(!down||!up)throw new Error("CoreGraphics mouse event unavailable; Accessibility/input permission required");
$.CGEventPost(0,down);
$.CGEventPost(0,up);
JSON.stringify({transport:"CoreGraphics OS pointer",pid:owners[0],application,point:{x:px,y:py},webArea:area});
