/** Group canonical decimal text without converting the monetary value to Number. */
export function reportMoney(value:string|number|null|undefined):string {
 const text=String(value??'0');
 if(!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return '—';
 const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
 return `${negative?'-':''}₦${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction.padEnd(2,'0')}`;
}

export function reportSum(values:readonly (string|number|null|undefined)[]):string {
 let sum=0n;
 for(const value of values){
  const text=String(value??'0');if(!/^-?\d+(?:\.\d{1,2})?$/.test(text)) return '—';
  const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
  const amount=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));sum+=negative?-amount:amount;
 }
 const magnitude=sum<0n?-sum:sum;
 return `${sum<0n?'-':''}${magnitude/100n}.${String(magnitude%100n).padStart(2,'0')}`;
}
