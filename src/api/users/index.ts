import { Router } from 'express';
import access from './access';
import request from './request';
import credentials from './credentials';
import tokens from './tokens';
import revoke_token from './revoke_token';

const route = Router();

route.use('/request.json', request);
route.use('/access.json', access);
route.use('/credentials.json', credentials);

const token_route = Router();
token_route.use('/show.json', tokens);
token_route.use('/revoke.json', revoke_token);

route.use('/tokens', token_route);

export default route;
