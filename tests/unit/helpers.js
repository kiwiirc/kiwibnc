const Helpers = require('../../src/libs/helpers');

class testCon {
    constructor(iSupports) {
        this.iSupports = iSupports;
    }
    iSupportToken(tokenName) {
        return this.iSupports[tokenName] || false;
    }
}

describe('libs/helpers.js', () => {
    it('should correctly parse channel modes with CHANMODES iSupport', () => {
        const con = new testCon({
            CHANMODES: 'IXZbegw,k,FHJLWdfjlx,ABCDKMNOPQRSTcimnprstuz',
            USERMODES: undefined,
            CHANTYPES: '#',
            PREFIX: '(Yohv)!@%+',
        });

        expect(
            Helpers.parseMode(
                con,
                '#chan1',
                '+ovm-vs+bk',
                ['nick1', 'nick2', 'nick3', 'nick4!*@*', 'testkey'],
            )
        ).toEqual({
            isChannel: true,
            target: '#chan1',
            modes: [
                { mode: '+o', param: 'nick1', type: Helpers.modeTypes.Prefix },
                { mode: '+v', param: 'nick2', type: Helpers.modeTypes.Prefix },
                { mode: '+m', param: null, type: Helpers.modeTypes.D },
                { mode: '-v', param: 'nick3', type: Helpers.modeTypes.Prefix },
                { mode: '-s', param: null, type: Helpers.modeTypes.D },
                { mode: '+b', param: 'nick4!*@*', type: Helpers.modeTypes.A },
                { mode: '+k', param: 'testkey', type: Helpers.modeTypes.B },
            ],
        });
    });

    it('should correctly parse channel modes with a weirdly ordered mode list ', () => {
        const con = new testCon({
            CHANMODES: 'IXZbegw,k,FHJLWdfjlx,ABCDKMNOPQRSTcimnprstuz',
            USERMODES: undefined,
            CHANTYPES: '#',
            PREFIX: '(Yohv)!@%+',
        });

        expect(
            Helpers.parseMode(
                con,
                '#channel',
                '-bl+i+b',
                ['*@192.168.0.1', '*@8.8.8.8'],
            )
        ).toEqual({
            isChannel: true,
            target: '#channel',
            modes: [
                { mode: '-b', param: '*@192.168.0.1', type: Helpers.modeTypes.A },
                { mode: '-l', param: null, type: Helpers.modeTypes.C },
                { mode: '+i', param: null, type: Helpers.modeTypes.D },
                { mode: '+b', param: '*@8.8.8.8', type: Helpers.modeTypes.A },
            ],
        });
    });

    it('should correctly parse user modes without USERMODES iSupport', () => {
        const con = new testCon({
            CHANMODES: 'IXZbegw,k,FHJLWdfjlx,ABCDKMNOPQRSTcimnprstuz',
            USERMODES: undefined,
            CHANTYPES: '#',
            PREFIX: '(Yohv)!@%+',
        });

        expect(
            Helpers.parseMode(
                con,
                'nick1',
                '+cx',
                [],
            )
        ).toEqual({
            isChannel: false,
            target: 'nick1',
            modes: [
                { mode: '+c', param: null, type: Helpers.modeTypes.D },
                { mode: '+x', param: null, type: Helpers.modeTypes.D },
            ],
        });
    });

    it('should correctly parse user modes with USERMODES iSupport', () => {
        const con = new testCon({
            CHANMODES: 'Ibw,k,Fjl,BMOPRSimnprst',
            USERMODES: ',,s,BIRSciorwx',
            CHANTYPES: '#',
            PREFIX: '(Yohv)!@%+',
        });

        expect(
            Helpers.parseMode(
                con,
                'nick1',
                '+cxs',
                ['+cCqQ'],
            )
        ).toEqual({
            isChannel: false,
            target: 'nick1',
            modes: [
                { mode: '+c', param: null, type: Helpers.modeTypes.D },
                { mode: '+x', param: null, type: Helpers.modeTypes.D },
                { mode: '+s', param: '+cCqQ', type: Helpers.modeTypes.C },
            ],
        });
    });
});
