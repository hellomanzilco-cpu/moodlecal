import type { ConnectionStage } from './types.ts';
export const CONNECTION_PHASES:Record<ConnectionStage,{percent:number;label:string}>={
  connecting:{percent:0,label:'Checking that Moodle is reachable…'},
  authenticating:{percent:20,label:'Verifying your Moodle sign-in…'},
  profile:{percent:40,label:'Loading your Moodle profile…'},
  synchronizing:{percent:65,label:'Synchronizing courses and assignments…'},
  dashboard:{percent:90,label:'Saving your data and preparing your dashboard…'},
};
export interface ConnectionState {
  language?:import('./locale.ts').Language;
  phase:ConnectionStage;percent:number;label:string;status:'working'|'complete'|'partial'|'failed';
  serverStatus:'not_started'|'pending'|'reachable'|'unavailable';
  authStatus:'not_started'|'pending'|'verified'|'rejected'|'unknown';
  profileStatus:'not_started'|'pending'|'loaded'|'unavailable';
  syncStatus:'not_started'|'pending'|'complete'|'partial'|'failed';
  dashboardStatus:'not_started'|'pending'|'prepared'|'failed';
  error?:string;diagnosticId?:number;coverageWarnings?:string[];linkHash:string;expires:number;
}
