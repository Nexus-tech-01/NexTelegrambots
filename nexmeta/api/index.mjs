import { handleRequest } from '../src/handler.mjs';

export default handleRequest;

export const config = {
  api: {
    bodyParser: false
  }
};
