import { Router } from "express";
import tweets from './tweets';
import users from './users';
import dmImage from './dm_media_proxy';

const route = Router();

route.use('/tweets.json', tweets);
route.use('/users.json', users);
route.use('/dm_proxy', dmImage);

export default route;
