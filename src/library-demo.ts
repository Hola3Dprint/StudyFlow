import type { LibraryApi, LibraryHit, LibraryLink } from "../shared/library";
import { SAMPLE_COURSES } from "./sample-data";
const docs:LibraryHit[] = ["Beam deflection worked examples.pdf","Engineering diagrams.pdf","Course syllabus.md"].map((title,i)=>({id:`demo-p-${i}`,documentId:`demo-d-${i}`,revision:"demo-revision",courseId:SAMPLE_COURSES[0].id,title,location:`Page ${i+1}`,snippet:i===0?"Worked beam deflection example: force, stiffness, boundary conditions and displacement.":i===1?"Cantilever beam diagram with a point load and fixed support.":"Course methods and formatting requirements.",kind:i===1?"visual":"keyword",score:1,visual:i===1}));
const links:LibraryLink[]=[{id:"demo-edge",source:"demo-d-0",target:"demo-d-1",kind:"semantic",reason:"Suggested: related beam examples. Not a Canvas requirement.",pinned:false,dismissed:false}];
export const libraryDemo:LibraryApi={
  forAssignment: async () => ({ items: [{ hit: docs[0], reason: "Demo: related course example" }], query: "beam", indexedDocuments: docs.length }),
  search:async q=>docs.filter(d=>(!q.courseIds||q.courseIds.includes(d.courseId))&&(!q.query||`${d.title} ${d.snippet}`.toLowerCase().includes(q.query.toLowerCase()))&&(!q.fileType||d.title.endsWith(q.fileType))&&(q.kind!=="visual"||d.visual)&&(q.kind!=="text"||!d.visual)),
  status:async()=>({state:"idle",completed:3,total:3,issues:[],modelsReady:true,documents:3,passages:3}),
  control:async()=>({state:"idle",completed:3,total:3,issues:[],modelsReady:true,documents:3,passages:3}),
  preview:async id=>{const hit=docs.find(d=>d.id===id)!;return {hit,text:hit.snippet,links};},
  related:async()=>links,
  graph:async input=>({nodes:[...SAMPLE_COURSES.map(c=>({id:`course:${c.id}`,courseId:c.id,title:c.name,kind:"course" as const,count:3})),...docs.filter(d=>input.expanded?.includes(d.courseId)||input.focus===d.documentId).map(d=>({id:d.documentId,courseId:d.courseId,title:d.title,kind:"document" as const}))],links:links.filter(l=>!l.dismissed),truncated:false}),
  link:async input=>{const link=links.find(l=>l.source===input.source&&l.target===input.target);if(link){link.pinned=input.action==="pin";link.dismissed=input.action==="dismiss";}},
  open:async()=>{},
};
