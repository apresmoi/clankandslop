export const ART_TOOLS = Object.freeze(['list_art_catalogue','bake_map','bake_glyph','inspect_artifact','inspect_catalogue_preview','lay_pages']);
export const VISUAL_TOOLS = Object.freeze({pressman:['prepare_release']});
const reporters=['cogsworth','sprockett','foreman','graves','tinkerton','vesta'];
const newsroomTools={klaxon:['qualify_signal'],brass:['record_assignment','record_freshness_check'],spike:['review_article'],ledger:['file_desk'],caslon:['file_desk','compose_edition'],pressman:['stage_release'],...Object.fromEntries(reporters.map(role=>[role,['file_article','record_dissent','record_freshness_check']]))};

export function runtimeToolFindings(agent, manifest) {
  const errors=[], base=`/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/${agent}`, tools=`${base}/tools/private/current/newsroom`;
  const servers=manifest.environment?.mcp_servers ?? [], resources=manifest.workspace?.resources ?? [];
  const allowed=['newsroom',...(agent==='caslon'?['art']:[]),...(VISUAL_TOOLS[agent]?['visual']:[]),...(reporters.includes(agent)?['validation']:[])];
  if (servers.some(server=>!allowed.includes(server.name))) errors.push('undeclared role server is prohibited');
  // Private code never enters the image: the tools are the team's fed volume
  // from the private checkout, read through current/, and never a bundle.
  const fed=resources.filter(item=>item.id==='newsroom-private-tools'), feed=fed[0]?.feed?.git;
  if (fed.length!==1 || fed[0].kind!=='volume' || fed[0].mount!=='./tools/private' || fed[0].sharing!=='team' || feed?.repo!=='../clankandslop-private' || !feed?.ref) errors.push('the private newsroom tools must be the team fed volume from the private checkout');
  if (resources.some(item=>item.kind==='bundle' && (item.source!==undefined ? !/^\.\.\/\.\.\/etopo-relief\.tar$/u.test(item.source) : /clankandslop-private/u.test(JSON.stringify(item.build ?? {}))))) errors.push('no private source may be baked into an image bundle');
  for (const name of ['newsroom','art','visual']) {
    const selected=servers.filter(item=>item.name===name);
    const expected=name==='newsroom' ? null : name==='art' ? agent==='caslon' ? ART_TOOLS : [] : VISUAL_TOOLS[agent] ?? [];
    if (expected?.length===0) { if (selected.length) errors.push(`${agent} cannot declare ${name} tools`); continue; }
    if (selected.length!==1) { errors.push(`one ${name} server is required`); continue; }
    const server=selected[0], env=server.env ?? {};
    if (env.CLANK_NEWSROOM_AGENT!==agent || env.CLANK_NEWSROOM_STATE_ADAPTER!==`${tools}/state/transaction.mjs` || env.CLANK_DAIMON_CONTROL_URL!=='http://127.0.0.1:19700' || env.CLANK_DAIMON_CONTROL_TOKEN_FILE!=='/run/clank-newsroom-control/token' || env.CLANK_DAIMON_AGENT_ID!==`agent:${agent}` || env.CLANK_STATE_OFFLINE_FIXTURE!==undefined) errors.push(`${name} requires trusted live role and wake admission`);
    if (name==='newsroom') {
      if (server.transport!=='stdio' || server.command!=='/usr/local/bin/node' || JSON.stringify(server.args)!==JSON.stringify([`${base}/repos/newsroom/agentic-org/scripts/production-newsroom-mcp.mjs`]) || JSON.stringify(server.tools)!==JSON.stringify(newsroomTools[agent])) errors.push('newsroom entry point or exact role tools are invalid');
      if (env.CLANK_EDITION_STATE_ROOT!==`${base}/state/edition`) errors.push('newsroom state mount is invalid');
      continue;
    }
    if (JSON.stringify(server.tools)!==JSON.stringify(expected) || server.transport!=='stdio' || server.command!=='/usr/local/bin/node' || JSON.stringify(server.args)!==JSON.stringify([`${tools}/${name}/server.mjs`])) errors.push(`${name} entry point or exact tool declaration is invalid`);
    if (env.CLANK_PUBLIC_SOURCE_ROOT!==`${base}/repos/newsroom` || env.CLANK_EDITION_STATE_ROOT!==`${base}/state/edition`) errors.push(`${name} source or state mount is invalid`);
  }
  return errors;
}
