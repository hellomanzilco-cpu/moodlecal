import type { ConnectionStage } from './types.ts';
export const CONNECTION_PHASES:Record<ConnectionStage,{percent:number;label:string}>={
  authenticating:{percent:10,label:'Connecting to Moodle…'},
  courses:{percent:30,label:'Fetching your courses…'},
  assignments:{percent:60,label:'Identifying your assignments…'},
  calendar:{percent:80,label:'Preparing your deadlines and calendar…'},
  saving:{percent:95,label:'Saving your private connection…'},
};
export interface ConnectionState {phase:ConnectionStage;percent:number;label:string;status:'working'|'complete'|'failed';error?:string;linkHash:string;expires:number}
