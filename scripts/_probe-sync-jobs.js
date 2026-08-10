
const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
(async()=>{
  const jobs=await p.syncJob.findMany({
    orderBy:{startedAt:'desc'},
    take:10,
    select:{jobType:true,status:true,startedAt:true,finishedAt:true,error:true,metadata:true}
  });
  console.log(JSON.stringify(jobs,null,2));
  await p.$disconnect();
})().catch(e=>{console.error(e); process.exit(1);});
