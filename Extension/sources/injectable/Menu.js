(() => {

    const MICSR = window.MICSR;

    const reqs = [];

    const setup = () => {
        MICSR.addModal = (title, id, content) => {
            // create modal
            const modal = document.createElement('div');
            modal.id = id;
            modal.className = 'modal';

            // create dialog
            const modalDialog = document.createElement('div');
            modalDialog.className = 'modal-dialog';
            modal.appendChild(modalDialog);

            // create content wrapper
            const modalContent = document.createElement('div');
            modalContent.className = 'modal-content';
            modalDialog.appendChild(modalContent);

            // create header
            const modalHeader = $(`<div class="block block-themed block-transparent mb-0"><div class="block-header bg-primary-dark">
        <h3 class="block-title">${title}</h3>
        <div class="block-options"><button type="button" class="btn-block-option" data-dismiss="modal" aria-label="Close">
        <i class="fa fa-fw fa-times"></i></button></div></div></div>`);
            $(modalContent).append(modalHeader);

            // add content
            content.forEach(x => modalContent.appendChild(x));

            // insert modal
            document.getElementById('page-container').appendChild(modal);

            // return modal
            return modal;
        }

        MICSR.createMenu = (title, menuID, eyeID) => {
            // check if tools menu already exists
            let menu = document.getElementById(menuID);
            if (menu !== null) {
                return menu;
            }

            // Create new tools menu
            menu = document.createElement('li');
            menu.id = menuID;
            menu.className = 'nav-main-heading mcsNoSelect';
            menu.textContent = title;

            // Create heading eye
            const headingEye = document.createElement('i');
            headingEye.className = 'far fa-eye text-muted ml-1';
            headingEye.id = eyeID;
            headingEye.onclick = () => MICSR.headingEyeOnClick(eyeID);
            headingEye.style.cursor = 'pointer';
            menu.appendChild(headingEye);
            window.MICSR_eyeHidden = false;

            // insert menu before Minigames
            document.getElementsByClassName('nav-main-heading').forEach(heading => {
                if (heading.textContent === 'Minigame') {
                    heading.parentElement.insertBefore(menu, heading);
                }
            });
        }

        /**
         * Callback for when sidebar eye is clicked
         */
        MICSR.headingEyeOnClick = (eyeID) => {
            const headingEye = document.getElementById(eyeID);
            if (window.MICSR_eyeHidden) {
                headingEye.className = 'far fa-eye text-muted ml-1';
                window.MICSR_menuTabs.forEach(tab => tab.style.display = '');
                window.MICSR_eyeHidden = false;
            } else {
                headingEye.className = 'far fa-eye-slash text-muted ml-1';
                window.MICSR_menuTabs.forEach(tab => tab.style.display = 'none');
                window.MICSR_eyeHidden = true;
            }
        }

        MICSR.addMenuItem = (itemTitle, iconSrc, accessID, modalID, menuTitle = 'Tools', menuID = 'mcsToolsMenu', eyeID = 'mcsHeadingEye') => {
            MICSR.createMenu(menuTitle, menuID, eyeID);
            if (window.MICSR_menuTabs === undefined) {
                window.MICSR_menuTabs = [];
            }

            const tabDiv = document.createElement('li');
            window.MICSR_menuTabs.push(tabDiv);
            tabDiv.id = accessID;
            tabDiv.style.cursor = 'pointer';
            tabDiv.className = 'nav-main-item mcsNoSelect';

            const menuButton = document.createElement('div');
            menuButton.className = 'nav-main-link nav-compact';
            menuButton.dataset.toggle = 'modal';
            menuButton.dataset.target = '#' + modalID;
            tabDiv.appendChild(menuButton);

            const icon = document.createElement('img');
            icon.className = 'nav-img';
            icon.src = iconSrc;
            menuButton.appendChild(icon);

            const menuText = document.createElement('span');
            menuText.className = 'nav-main-link-name';
            menuText.textContent = itemTitle;
            menuButton.appendChild(menuText);

            document.getElementById(menuID).after(tabDiv);

            // return access point
            return tabDiv;
        }

        MICSR.destroyMenu = (menuItemId, modalID, menuID = 'mcsToolsMenu') => {
            // remove the MICSR tab access point
            const tab = document.getElementById(menuItemId);
            if (tab !== null) {
                window.MICSR_menuTabs = window.MICSR_menuTabs.filter(x => x !== tab);
                tab.remove();
            }
            // remove the tools menu if it is empty
            const menu = document.getElementById(menuID);
            if (menu !== null && menu.length === 0) {
                menu.remove();
            }
            // hide and remove the modal
            const modal = document.getElementById(modalID);
            if (modal !== null) {
                $(modal).modal('hide');
                $(modal).modal('dispose');
                modal.remove();
            }
        }
    }

    MICSR.waitLoadOrder(reqs, setup, 'Menu')

})();