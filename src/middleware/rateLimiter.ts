import {Request,Response,NextFunction} from "express";


const LIMIT = 5;
const WINDOW = 10000; // 10 seconds
const requests = new Map<string, ClientData>();


type ClientData = {
count:number;
windowStart: number;
}  
function recordRequest(client: string) {
  const data = requests.get(client) ;
// First request from this client
  if(!data){
   requests.set(client,{
    count:1,
    windowStart: Date.now()
   });
   console.log("request allowed");
   return true;
  }

  //expiry time of the window
  const elapsedTime = Date.now() - data.windowStart;

 
   if (elapsedTime >= WINDOW) {
    data.count = 1;
    data.windowStart = Date.now();
    console.log("New window Request allowed");
    return true;
  }

   //check if the request count has exceeded the limit
  if (data.count >= LIMIT) {
    console.log("Request limit exceeded");
    return false;
  }
  data.count++;
  return true;
  
}


export function rateLimiter(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const client = req.ip;

  const allowed = recordRequest(client);

  if (!allowed) {
    res.status(429).json({
      message: "Too many requests"
    });

    return;
  }

  next();
}