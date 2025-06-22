/**
 * MUCH OF THIS CODE HAS BEEN BORROWED FROM OR IS A LIGHTLY MODIFIED VERSION OF THE MOD.TS FROM ACIDPHANTASM'S HARRYHIDEOUT MOD, I DO NOT CLAIM ANY CREDIT FOR THIS
 */
import { DependencyContainer, container } from "tsyringe";

// SPT types
import { IPreSptLoadMod } from "@spt/models/external/IPreSptLoadMod";
import { IPostDBLoadMod } from "@spt/models/external/IPostDBLoadMod";
import { ILogger } from "@spt/models/spt/utils/ILogger";
import { PreSptModLoader } from "@spt/loaders/PreSptModLoader";
import { DatabaseService } from "@spt/services/DatabaseService";
import { ImageRouter } from "@spt/routers/ImageRouter";
import { ConfigServer } from "@spt/servers/ConfigServer";
import { ConfigTypes } from "@spt/models/enums/ConfigTypes";
import { ITraderConfig } from "@spt/models/spt/config/ITraderConfig";
import { IRagfairConfig } from "@spt/models/spt/config/IRagfairConfig";
import { ItemHelper } from "@spt/helpers/ItemHelper";
import { DynamicRouterModService } from "@spt/services/mod/dynamicRouter/DynamicRouterModService";
import { JsonUtil } from "@spt/utils/JsonUtil";
import { BaseClasses} from "@spt/models/enums/BaseClasses";
import * as fs from "node:fs";
import * as path from "node:path";

// New trader settings
import * as baseJson from "../db/base.json";
import { TraderHelper } from "./traderHelpers";
import { FluentAssortConstructor as FluentAssortCreator } from "./fluentTraderAssortCreator";
import { Money } from "@spt/models/enums/Money";
import { Traders } from "@spt/models/enums/Traders";
import { HashUtil } from "@spt/utils/HashUtil";

let realismDetected:boolean;

class ChefBoyardyev implements IPreSptLoadMod, IPostDBLoadMod
{
    private mod: string
    private logger: ILogger
    private traderHelper: TraderHelper
    private fluentAssortCreator: FluentAssortCreator
    private static config: Config;
    private static itemsPath = path.resolve(__dirname, "../config/items.json");
    private static configPath = path.resolve(__dirname, "../config/config.json");

    constructor() {
        this.mod = "ChefBoyardyev"; // Set name of mod so we can log it to console later
    }
    /**
     * Some work needs to be done prior to SPT code being loaded, registering the profile image + setting trader update time inside the trader config json
     * @param container Dependency container
     */
    public preSptLoad(container: DependencyContainer): void
    {
        // Get a logger
        this.logger = container.resolve<ILogger>("WinstonLogger");

        // Get SPT code/data we need later
        const preSptModLoader: PreSptModLoader = container.resolve<PreSptModLoader>("PreSptModLoader");
        const imageRouter: ImageRouter = container.resolve<ImageRouter>("ImageRouter");
        const databaseService: DatabaseService = container.resolve<DatabaseService>("DatabaseService");
        const hashUtil: HashUtil = container.resolve<HashUtil>("HashUtil");
        const configServer = container.resolve<ConfigServer>("ConfigServer");
        const traderConfig: ITraderConfig = configServer.getConfig<ITraderConfig>(ConfigTypes.TRADER);
        const ragfairConfig = configServer.getConfig<IRagfairConfig>(ConfigTypes.RAGFAIR);
        const dynamicRouterModService = container.resolve<DynamicRouterModService>("DynamicRouterModService");

        //Load config file before accessing it
        ChefBoyardyev.config = JSON.parse(fs.readFileSync(ChefBoyardyev.configPath, "utf-8"));

        // Set config values to local variables for validation & use
        let minRefresh = ChefBoyardyev.config.traderRefreshMin;
        let maxRefresh = ChefBoyardyev.config.traderRefreshMax;
        const addToFlea = ChefBoyardyev.config.addTraderToFlea;
        if (minRefresh >= maxRefresh)
        {
            minRefresh = 1800;
            maxRefresh = 3600;
            this.logger.error(`[${this.mod}] [Config Issue]  traderRefreshMin must be less than traderRefreshMax. Refresh timers have been reset to default.`);
        }
        if (maxRefresh <= 2)
        {
            minRefresh = 1800;
            maxRefresh = 3600;
            this.logger.error(`[${this.mod}] [Config Issue]  You set traderRefreshMax too low. Refresh timers have been reset to default.`);
        }

        // Create helper class and use it to register our traders image/icon + set its stock refresh time
        this.traderHelper = new TraderHelper();
        this.fluentAssortCreator = new FluentAssortCreator(hashUtil, this.logger);
        this.traderHelper.registerProfileImage(baseJson, this.mod, preSptModLoader, imageRouter, "ChefBoyardyev.jpg");
        this.traderHelper.setTraderUpdateTime(traderConfig, baseJson, minRefresh, maxRefresh);

        // Add trader to trader enum
        Traders[baseJson._id] = baseJson._id;

        // Add trader to flea market
        if (addToFlea)
        {
            ragfairConfig.traders[baseJson._id] = true;
        }
        else
        {
            ragfairConfig.traders[baseJson._id] = false;
        }
        dynamicRouterModService.registerDynamicRouter(
            "ChefBoyardyevRefreshStock",
            [
                {
                    url: "/client/items/prices/ChefBoyardyev",
                    action: async (url, info, sessionId, output) => 
                    {
                        const trader = databaseService.getTables().traders["ChefBoyardyev"];
                        const assortItems = trader.assort.items;
                        return output;
                    }
                }
            ],
            "spt"
        );
    }
    
    /**
     * Majority of trader-related work occurs after the spt database has been loaded but prior to SPT code being run
     * @param container Dependency container
     */
    public postDBLoad(container: DependencyContainer): void
    {

        ChefBoyardyev.config = JSON.parse(fs.readFileSync(ChefBoyardyev.configPath, "utf-8"));

        // Resolve SPT classes we'll use
        const preSptModLoader: PreSptModLoader = container.resolve<PreSptModLoader>("PreSptModLoader");
        const logger = container.resolve<ILogger>("WinstonLogger");
        const databaseService: DatabaseService = container.resolve<DatabaseService>("DatabaseService");
        const jsonUtil: JsonUtil = container.resolve<JsonUtil>("JsonUtil");
        const priceTable = databaseService.getTables().templates.prices;
        const handbookTable = databaseService.getTables().templates.handbook;

        // Get a reference to the database tables
        const tables = databaseService.getTables();

        // Add new trader to the trader dictionary in DatabaseService - has no assorts (items) yet
        this.traderHelper.addTraderToDb(baseJson, tables, jsonUtil);
        const start = performance.now();

        //Detect Realism
        const realismCheck = preSptModLoader.getImportedModsNames().includes("SPT-Realism");
        this.setRealismDetection(realismCheck);

        //get a list of all key ids in the game
        const listOfKeys = this.getKeyIds();

        //iterate through the list of keys and set the prices then add to the assort
        const priceReduction = 0.80;
        for (const itemID of listOfKeys)
        {
            //check the price table for the price of the item and then multiply that by the price reduction and the pricemultiplier in the config    
            let price = (priceTable[itemID] * priceReduction)  * ChefBoyardyev.config.itemPriceMultiplier;
            //if there is no price in the price table take the handbook price of the item, multiply it by our pricereduction variable, then multiply that by the pricemultiplier in the config
            if (!price)
            {
                price = ((handbookTable.Items.find(x => x.Id === itemID)?.Price ?? 1) * priceReduction)  * ChefBoyardyev.config.itemPriceMultiplier;
            }
            this.fluentAssortCreator.createSingleAssortItem(itemID)
                .addUnlimitedStackCount()
                .addMoneyCost(Money.ROUBLES, Math.round(price))
                .addLoyaltyLevel(1)
                .export(tables.traders[baseJson._id])
            if (ChefBoyardyev.config.debugLogging){
                logger.log("ItemID: " + itemID + " for price: " + Math.round(price), "cyan");
            }
        }
        

        // Add trader to locale file, ensures trader text shows properly on screen
        // WARNING: adds the same text to ALL locales (e.g. chinese/french/english)
        this.traderHelper.addTraderToLocales(baseJson, tables, baseJson.name, "Chef Boyardyev", baseJson.nickname, baseJson.location, "Itsa justa likea my momma used toa makea");

        this.logger.debug(`[${this.mod}] loaded... `);

        const timeTaken = performance.now() - start;
        if (ChefBoyardyev.config.debugLogging) {logger.log(`[${this.mod}] Assort generation took ${timeTaken.toFixed(3)}ms.`, "green");}
    }

    private getKeyIds(): string[]
    {
        //load in the entire items database
        const items = container.resolve<DatabaseService>("DatabaseService").getTables().templates.items;
        //load in the itemhelper
        const itemHelper = container.resolve<ItemHelper>("ItemHelper");
        //create an empty object to store our list of key id's in
        const listOfKeys = [];
        //iterate through every item in the database
        for(const itemID in items)
        {
            const eachItem = items[itemID]
            //make sure it is an item
            if(eachItem._type !== "Item")
            {
                continue;
            }
            //check if it is a key
            if(!itemHelper.isOfBaseclass(eachItem._id, BaseClasses.FOOD))
            {
                if(!itemHelper.isOfBaseclass(eachItem._id, BaseClasses.DRINK))
                {
                    continue;
                }
            }
            //make sure it isn't a quest key
            if(eachItem._props.QuestItem)
            {
                continue;
            }
            //if it meets all of the above requirements add it to our list of items
            listOfKeys.push(eachItem._id);
        }
        return listOfKeys;
    }

    private setRealismDetection(i: boolean)
    {
        realismDetected = i;
        if (realismDetected)
        {
            this.logger.log(`[${this.mod}] SPT-Realism detected, disabling randomizeBuyRestriction and/or randomizeStockAvailable:`, "yellow");
        }
    }    
}

interface Config 
{
    itemPriceMultiplier: number,
    traderRefreshMin: number,
    traderRefreshMax: number,
    addTraderToFlea: boolean,
    debugLogging: boolean,
}

module.exports = { mod: new ChefBoyardyev() }