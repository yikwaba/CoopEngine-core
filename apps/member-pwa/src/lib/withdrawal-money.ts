export function memberMoney(value:string|number):string {
 const text=String(value);if(!/^-?\d+(?:\.\d{1,2})?$/.test(text))return '—';
 const negative=text.startsWith('-'),[whole,fraction='']=(negative?text.slice(1):text).split('.');
 return `${negative?'-':''}₦${whole!.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction.padEnd(2,'0')}`;
}
/** Preserve the endpoint's existing bounded numeric request contract. */
export function withdrawalAmount(value:string):number {
 const text=value.trim();if(text.length>24||!/^\d+(?:\.\d{1,2})?$/.test(text))throw new Error('Enter an amount with up to two decimal places.');
 const [whole,fraction='']=text.split('.'),kobo=BigInt(whole!)*100n+BigInt(fraction.padEnd(2,'0'));
 if(kobo<100n||kobo>10_000_000_000_000n)throw new Error('Amount must be between ₦1.00 and ₦100,000,000,000.00.');
 return Number(text);
}
