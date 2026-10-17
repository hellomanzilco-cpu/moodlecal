export const telegramDisplayNameContext=(studentId:number)=>`telegram-display-name:${studentId}`;

export function telegramDisplayName(firstName:string,lastName:string):string {
  return [firstName,lastName].map(value=>value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,200)).filter(Boolean).join(' ').slice(0,300);
}
