import { waitUntil } from '@vercel/functions';
import { handleRequest } from '../src/handler.mjs';

export default async function handler(req, res) {
  req.nexmetaWaitUntil = waitUntil;
  return handleRequest(req, res);
}

export const config = {
  api: {
    bodyParser: false
  }
};
