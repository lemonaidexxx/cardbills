import {randomBytes} from 'node:crypto';
console.log(JSON.stringify({SESSION_KEY:randomBytes(32).toString('hex'),BRIDGE_SECRET:randomBytes(32).toString('hex')},null,2));
